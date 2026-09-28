import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { memoryHubRepository } from './memory-hub.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEventEntitlement, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';

// Called before issuing an upload signature (organiser AND guest paths)
// and before viewing/managing a hub in ways that assume the tier
// permits it at all. Spark has no Memory Hub — this is the
// all-or-nothing gate, read at runtime, never hardcoded, so a Super
// Admin toggling memoryHubEnabled takes effect immediately.
//
// EVENT-SCOPED (Event Pass batch) — "belongs to an event," per the
// batch prompt's own classification. Takes the full fetched event, not
// a bare tenantId, so a missed call site fails to compile rather than
// falling back to tenant-only resolution.
//
// Subscription Billing batch audit: considered, and deliberately did
// NOT exempt, the guest upload path (memory-hub.service.ts's
// requestGuestUploadSignature) the way ticket purchases were exempted
// for an already-published paid event. The two look similar but
// aren't: every Event gets a MemoryHub row unconditionally at creation
// regardless of tier (event.repository.ts's create()), so a SPARK
// tenant who NEVER had Memory Hub access still has a hub row sitting
// there. There is no stored fact distinguishing "this hub was actually
// enabled and used while paying, then lapsed" from "this tenant never
// had access at all" — TicketPurchase has no such ambiguity, since a
// PAID event can only exist if it passed this exact gate at creation
// or publish time. Bypassing this check for guests would therefore
// hand SPARK tenants who never paid for Memory Hub a working guest
// upload flow, which is a different and wrong outcome, not a
// conservative one. Left gated on effective entitlement like every
// other capability check; flagged here rather than fixed, since a
// correct fix needs a new "was this feature genuinely provisioned"
// fact on the hub itself, which is a schema decision beyond this ticket.
// `audience` picks the message only — the check itself is identical for
// both callers. 'guest' is used by the guest-upload-signature route
// (memory-hub.service.ts's requestGuestUploadSignature): STEERING's
// Contract C rule says tier/plan/upgrade language must never reach a
// guest, so that one call site swaps in wording with no plan name, no
// tier name, no "upgrade". Every organiser call site keeps the default
// and is unaffected.
export const assertMemoryHubAccessible = async (
  event: EntitlementDerivableEvent,
  audience: 'organiser' | 'guest' = 'organiser'
): Promise<void> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  const effectiveTier = resolveEventEntitlement(tenant, event);
  const config = await subscriptionTierConfigRepository.findByTier(effectiveTier);
  if (!config?.memoryHubEnabled) {
    throw new HttpError(
      403,
      audience === 'guest'
        ? "This event doesn't have a Memory Hub available."
        : `The ${effectiveTier} plan does not include Memory Hub. Upgrade to CELEBRATE or ELEVATE to use it.`
    );
  }
};

// Non-throwing variant of the check above — used by
// memory-hub.service.ts's getGuestView (Contract B), which decides
// whether to show the Memory Hub tab at all and must return `available:
// false` with NO reason (STEERING: guest-facing responses), not a 403
// with a message nobody reads. Any lookup failure (tenant genuinely
// missing) reads as "not available" here too — the same fail-safe
// default as every other flag that function returns.
export const isMemoryHubTierEnabled = async (event: EntitlementDerivableEvent): Promise<boolean> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) return false;
  const config = await subscriptionTierConfigRepository.findByTier(resolveEventEntitlement(tenant, event));
  return !!config?.memoryHubEnabled;
};

// null = unlimited, same convention as every other max* column. Used
// for the BYTE QUOTA, which — unlike assertMemoryHubAccessible above —
// still applies on the guest path: it bounds EventGenie's own ongoing
// storage cost, not a capability switch, so it stays in effect
// regardless of billing state (falling back to whatever the EVENT's
// current entitlement's config says, same as everywhere else — Event
// Pass batch: a Large-pass event should get Elevate's unlimited quota,
// not the tenant's own Celebrate ceiling, exactly like every other
// capability this tier maps to).
export const getMemoryHubQuotaBytes = async (event: EntitlementDerivableEvent): Promise<number | null> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  const config = await subscriptionTierConfigRepository.findByTier(resolveEventEntitlement(tenant, event));
  return config?.maxMemoryHubBytesPerEvent ?? null;
};

// ─────────────────────────────────────────
//  QUOTA — summed on demand, never a running counter (see
//  memory-hub.repository.ts's sumBytesForEvent for the query and why).
//
//  Called BEFORE issuing an upload signature — a signature is a grant;
//  issuing one when the event is already at its limit means the file
//  uploads to Cloudinary and is then rejected, wasting the guest's
//  bandwidth and our storage bill for nothing. This can only check
//  "is the event already at/over capacity" — the incoming file's exact
//  size is unknowable until Cloudinary reports it after upload, so the
//  very last upload that tips an event over its limit can still land;
//  memory-hub.service.ts's persist step re-checks with the real byte
//  count and destroys+rejects that one if needed. See the batch report.
// ─────────────────────────────────────────
export const assertMemoryHubQuotaAvailable = async (
  event: EntitlementDerivableEvent & { id: string },
  audience: 'organiser' | 'guest' = 'organiser'
): Promise<void> => {
  const maxBytes = await getMemoryHubQuotaBytes(event);
  if (maxBytes == null) return;

  const usedBytes = await memoryHubRepository.sumBytesForEvent(event.id);
  if (usedBytes >= maxBytes) {
    // Guest-safe wording (Contract C) — no MB figure, no plan/tier name,
    // no "upgrade". Same audience convention as assertMemoryHubAccessible.
    if (audience === 'guest') {
      throw new HttpError(403, "This event's photo album is full, so new photos can't be added right now.");
    }
    const tenant = await tenantRepository.findById(event.tenantId);
    const effectiveTier = tenant ? resolveEventEntitlement(tenant, event) : 'current';
    throw new HttpError(
      403,
      `This event's Memory Hub has reached its ${Math.round(maxBytes / (1024 * 1024))}MB storage limit for the ${effectiveTier} plan. Remove items or upgrade the plan to add more.`
    );
  }
};
