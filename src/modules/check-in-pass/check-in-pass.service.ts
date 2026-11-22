import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { resolveEventPlan } from '../subscription-tier-config/effective-plan.util.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { assertEventNotArchived } from '../rsvp/rsvp-guards.util.js';
import { checkInPassRepository, type NewPass, type PassRow, type RsvpParty } from './check-in-pass.repository.js';
import { rsvpPartyPasses, passKey, displayName } from './check-in-pass-kinds.js';
import { buildPassPayload } from './check-in-pass-token.util.js';
import { type GuestPassList } from './check-in-pass.types.js';

// ─────────────────────────────────────────
//  ISSUING CHECK-IN PASSES (RSVP)
//
//  syncParty brings one party's passes (the guest who RSVP'd and their
//  plus-ones) in line with their RSVP as it is now: a pass for each person
//  and day that should have one and doesn't, and every other active pass of
//  theirs revoked. Called after anything that changes the answer (RSVP
//  submit, registration, approving or declining one, removing or restoring
//  a guest or an invite) and, lazily, whenever the guest's page asks for
//  its passes, which is how guests who accepted before passes existed get
//  theirs.
//
//  Race-safe: every reconcile of a party holds a lock on its guest row, so
//  two at once run one after the other and the second reads what the first
//  wrote, and the database allows one active pass per person per day
//  however they arrive (createMany skips a duplicate).
//
//  A pass whose person and day are still wanted is kept, so an RSVP edit
//  that leaves someone's days alone doesn't change their code. A plus-one is
//  a new Guest row on every edit of the RSVP (rsvp.service.ts), so their
//  codes change with each edit.
//
//  With the qrCheckIn flag off, or the event's plan without QR check-in, no
//  pass is issued; passes that are no longer wanted are still revoked.
//  Whatever happens here, a scan checks the pass against the RSVP again
//  (check-in-pass-kinds.ts), so a reconcile that failed can't let anyone in.
// ─────────────────────────────────────────

const PAGE_NOT_FOUND = "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.";

// Whether this event issues passes: the flag, then the event's plan.
export const isQrCheckInOnForEvent = async (eventId: string): Promise<boolean> => {
  if (!isFeatureEnabled('qrCheckIn')) return false;
  const event = await checkInPassRepository.findEventForPlan(eventId);
  if (!event) return false;
  const tenant = await tenantRepository.findById(event.tenantId, true);
  if (!tenant) return false;
  return (await resolveEventPlan(tenant, event)).values.qrCheckInEnabled;
};

// What a reconcile of the party would change: active passes no longer wanted
// (revoked), and wanted ones not held (issued, only while issuing). The same
// answer decides whether a page load needs the lock at all.
export const planReconcile = (party: RsvpParty, active: PassRow[], issuing: boolean) => {
  const { wanted, revokeReason } = rsvpPartyPasses(party);
  const wantedKeys = new Set(wanted.map(passKey));
  const stale = active.filter((p) => p.kind !== 'RSVP' || !wantedKeys.has(passKey(p)));
  const held = new Set(active.filter((p) => !stale.includes(p)).map(passKey));
  const missing: NewPass[] = issuing
    ? wanted
        .filter((w) => !held.has(passKey(w)))
        .map((w) => ({ eventId: party.eventId, eventDayId: w.eventDayId, guestId: party.id, plusOneGuestId: w.plusOneGuestId, kind: 'RSVP' }))
    : [];
  return { stale, missing, revokeReason };
};

// The locked reconcile: the party's rows read again under the lock (the
// first request's writes are what the second one reads), then the changes
// written. Whether the event issues passes is returned for the page.
const syncParty = async (guestId: string, known?: { issuing: boolean }): Promise<boolean> => {
  const head = await checkInPassRepository.findPartyHead(guestId);
  if (!head) return false;
  const { partyGuestId } = head;
  const issuing = known?.issuing ?? (await isQrCheckInOnForEvent(head.eventId));
  // Outside the transaction: one nested read, which inside it Prisma would
  // run as parallel queries on the transaction's one connection.
  const event = (await checkInPassRepository.findParty(partyGuestId))?.event;
  if (!event) return issuing;

  await prisma.$transaction(
    async (tx) => {
      await checkInPassRepository.lockParty(tx, partyGuestId);
      const party = await checkInPassRepository.findPartyLocked(tx, partyGuestId, event);
      if (!party) return;
      const active = await checkInPassRepository.findActiveForParty(partyGuestId, tx);
      const { stale, missing, revokeReason } = planReconcile(party, active, issuing);
      if (stale.length) await checkInPassRepository.revoke(stale.map((p) => p.id), revokeReason, tx);
      if (missing.length) await checkInPassRepository.createMissing(missing, tx);
    },
    { timeout: 15000, maxWait: 10000 }
  );
  return issuing;
};

// The page load's first step: the party and its active passes READ, no lock,
// no transaction, compared as the reconcile would. Only when something is
// missing or out of date does it take the lock (syncParty, which reads
// everything again under it). An unchanged load writes nothing.
const syncPartyIfNeeded = async (partyGuestId: string, eventId: string): Promise<boolean> => {
  const issuing = await isQrCheckInOnForEvent(eventId);
  const party = await checkInPassRepository.findParty(partyGuestId);
  if (!party) return issuing;
  const active = await checkInPassRepository.findActiveForParty(partyGuestId);
  const { stale, missing } = planReconcile(party, active, issuing);
  if (stale.length || missing.length) await syncParty(partyGuestId, { issuing });
  return issuing;
};

export const checkInPassService = {
  syncParty,

  // After a write that has already committed (an RSVP, a decision, a
  // removal): a failure here must not turn that success into an error. It
  // is reported, and the next page load or scan puts it right.
  syncPartyQuietly: async (guestId: string): Promise<void> => {
    try {
      await syncParty(guestId);
    } catch (err) {
      console.error(`[check-in-pass] sync failed for guest ${guestId}`);
      reportError(err);
    }
  },

  // POST /api/rsvp/passes — the accepted guest's door codes: their own and
  // their plus-ones', one per person per day, issued here first if they
  // haven't been (guests who accepted before passes existed). Refused
  // exactly as the invitation is (an unknown, removed, pending or declined
  // registration's token: 404; an archived event: 410). A guest who hasn't
  // accepted, a cancelled event, or a plan without QR check-in: no passes,
  // with no reason given (no plan language reaches a guest).
  listForToken: async (token: unknown): Promise<GuestPassList> => {
    if (typeof token !== 'string' || !token) throw new HttpError(400, 'token is required');
    const invite = await checkInPassRepository.findInviteForPasses(token);
    if (!invite) throw new HttpError(404, PAGE_NOT_FOUND);
    assertEventNotArchived(invite.event);

    const status = resolveEffectiveStatus(invite.event);
    if (status === 'CANCELLED' || status === 'DRAFT') return { passes: [] };

    const partyGuestId = invite.guest.hostGuestId ?? invite.guestId;
    // Read first; the lock only when something changed. A failed sync still
    // shows the passes already held (reported, and put right on the next
    // load); the plan is then read on its own.
    let issuing: boolean;
    try {
      issuing = await syncPartyIfNeeded(partyGuestId, invite.eventId);
    } catch (err) {
      console.error(`[check-in-pass] sync failed for guest ${partyGuestId}`);
      reportError(err);
      issuing = await isQrCheckInOnForEvent(invite.eventId);
    }
    // A plan without QR check-in shows nothing, whatever was issued before.
    if (!issuing) return { passes: [] };

    // A plus-one's own token (never sent, but it exists) shows only theirs.
    const rows = await checkInPassRepository.findActiveForPage(partyGuestId, invite.guest.hostGuestId ? invite.guestId : null);
    return {
      passes: rows.map((row) => ({
        personName: displayName(row.plusOneGuestId ? row.plusOneGuest : row.guest),
        isPlusOne: row.plusOneGuestId !== null,
        day: { id: row.eventDay.id, label: row.eventDay.label, date: row.eventDay.date },
        payload: buildPassPayload(row),
      })),
    };
  },
};
