import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { describeUnsendable, type UnsendableReason } from '../../src/modules/invite/invite-selection.util.js';
import { describeSkips, type ReminderSkipReason } from '../../src/modules/invite/invite-reminder.util.js';
import { createTenant, createActor, createEventWithDay, assign, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  SEND AND REMIND A SELECTION THAT HOLDS GUESTS WHO CAN'T BE SENT TO
//
//  A removed guest, a plus-one, a registration awaiting approval or
//  declined, a guest with no live invitation, or a guest of another of the
//  organiser's events is left out and named (name and contact, a reason);
//  everyone else goes. Until 2026-11 one such guest refused the whole send
//  and the message listed database ids.
//
//  A guest the caller can't reach (another tenant's, a made-up id, an event
//  the assignment lock hides) still refuses the whole request, naming
//  nobody.
// ─────────────────────────────────────────

let tenantId: string;
let otherTenantId: string;
let organiser: Actor;
let locked: Actor;
let eventId: string;
let siblingEventId: string; // same tenant, the locked member is assigned
let hiddenEventId: string; // same tenant, the locked member is not
let foreignEventId: string;
let foreignOrganiserId: string;

interface Seeded { guestId: string; inviteId: string | null; email: string; name: string }

const seed = async (
  evId: string,
  createdBy: string,
  opts: {
    first?: string;
    archived?: boolean;
    hostGuestId?: string;
    pendingApproval?: boolean;
    declined?: boolean;
    invite?: 'live' | 'archived' | 'none';
    delivered?: boolean;
  } = {}
): Promise<Seeded> => {
  const guestId = randomUUID();
  const email = `sel-${randomUUID()}@test.invalid`;
  const first = opts.first ?? `Guest${guestId.slice(0, 4)}`;
  await prisma.guest.create({
    data: {
      id: guestId, eventId: evId, firstName: first, surname: 'Mokoena', email,
      isArchived: opts.archived ?? false,
      hostGuestId: opts.hostGuestId ?? null,
      pendingApproval: opts.pendingApproval ?? false,
      registrationDeclinedAt: opts.declined ? new Date() : null,
    },
  });
  const invite = opts.invite ?? 'live';
  if (invite === 'none') return { guestId, inviteId: null, email, name: `${first} Mokoena` };
  const inviteId = randomUUID();
  await prisma.invite.create({
    data: {
      id: inviteId, eventId: evId, guestId, token: `sel-${randomUUID()}`, status: 'PENDING', deliveryMethod: 'EMAIL',
      isArchived: invite === 'archived', deliveredAt: opts.delivered ? new Date(Date.now() - 3 * 86_400_000) : null,
      createdBy, updatedBy: createdBy,
    },
  });
  return { guestId, inviteId, email, name: `${first} Mokoena` };
};

const post = (actor: Actor, path: string, body: object, evId = eventId) =>
  request(app).post(`/api/events/${evId}/invites${path}`).set(headersFor(actor)).send(body);

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  otherTenantId = (await createTenant()).id;
  organiser = await createActor('TENANT_ADMIN', tenantId);
  locked = await createActor('EVENT_ADMIN', tenantId);
  const main = await createEventWithDay(tenantId, organiser.id, `Selection ${randomUUID()}`);
  eventId = main.event.id;
  siblingEventId = (await createEventWithDay(tenantId, organiser.id)).event.id;
  hiddenEventId = (await createEventWithDay(tenantId, organiser.id)).event.id;
  await assign(tenantId, locked.id, eventId, organiser.id);
  await assign(tenantId, locked.id, siblingEventId, organiser.id);
  const foreignOrganiser = await createActor('TENANT_ADMIN', otherTenantId);
  foreignOrganiserId = foreignOrganiser.id;
  foreignEventId = (await createEventWithDay(otherTenantId, foreignOrganiser.id)).event.id;
}, 60_000);

afterAll(async () => {
  await deleteTenantsDeep([tenantId, otherTenantId]);
}, 60_000);

beforeEach(async () => {
  installFirebaseMock();
  await prisma.emailSend.deleteMany({ where: { eventId } });
  await prisma.eventEmailClaim.deleteMany({ where: { eventId } });
});

// Every guest a selection can hold that can't be sent to, with the reason
// it should come back with.
const seedUnsendable = async () => {
  const host = await seed(eventId, organiser.id, { first: 'Host' });
  const cases = {
    ARCHIVED: await seed(eventId, organiser.id, { first: 'Removed', archived: true }),
    PLUS_ONE: await seed(eventId, organiser.id, { first: 'Plus', hostGuestId: host.guestId }),
    PENDING_APPROVAL: await seed(eventId, organiser.id, { first: 'Pending', pendingApproval: true }),
    REGISTRATION_DECLINED: await seed(eventId, organiser.id, { first: 'Declined', declined: true, archived: true }),
    NO_INVITATION: await seed(eventId, organiser.id, { first: 'Uninvited', invite: 'archived' }),
    NOT_IN_EVENT: await seed(siblingEventId, organiser.id, { first: 'Sibling' }),
  };
  return { host, cases };
};

const expectNamedSkips = (skippedGuests: { guestId: string; name: string; contact: string; reason: string; message: string }[], cases: Record<string, Seeded>) => {
  for (const [reason, g] of Object.entries(cases)) {
    const skip = skippedGuests.find((s) => s.guestId === g.guestId);
    expect(skip, reason).toMatchObject({ name: g.name, contact: g.email, reason, message: expect.any(String) });
  }
  // The words never carry an id.
  for (const s of skippedGuests) {
    for (const g of Object.values(cases)) {
      expect(s.message).not.toContain(g.guestId);
      expect(s.name).not.toContain(g.guestId);
    }
  }
};

describe('Send: guests who can’t be sent to are skipped and named; the rest are queued', () => {
  it('one sendable guest plus every kind that can’t be sent to: 200, one queued, six named skips', async () => {
    const { host, cases } = await seedUnsendable();
    const res = await post(organiser, '/send', { guestIds: [host.guestId, ...Object.values(cases).map((g) => g.guestId)] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ totalSelected: 7, queued: 1, sent: 0, failed: 0, skipped: 6, sendId: expect.any(String) });
    expect(data.queued + data.sent + data.failed + data.skipped).toBe(data.totalSelected);
    expectNamedSkips(data.skippedGuests, cases);
    for (const s of data.skippedGuests) expect(s.sendId).toBeNull();

    // Only the sendable guest's email is queued.
    const items = await prisma.emailSendItem.findMany({ where: { sendId: data.sendId } });
    expect(items.map((i) => i.inviteId)).toEqual([host.inviteId]);
  });

  it('a selection of only guests who can’t be sent to: 200, nothing queued, all named', async () => {
    const { cases } = await seedUnsendable();
    const res = await post(organiser, '/send', { guestIds: Object.values(cases).map((g) => g.guestId) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ totalSelected: 6, sendId: null, queued: 0, skipped: 6 });
    expectNamedSkips(res.body.data.skippedGuests, cases);
    expect(await prisma.emailSendItem.count({ where: { eventId } })).toBe(0);
  });
});

describe('a guest outside the caller’s reach still refuses the whole request, naming nobody', () => {
  const refusesWhole = async (actor: Actor, path: '/send' | '/remind', outsider: Seeded) => {
    const insider = await seed(eventId, organiser.id, { delivered: path === '/remind' });
    const res = await post(actor, path, { guestIds: [insider.guestId, outsider.guestId] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('GUEST_SELECTION_UNKNOWN');
    const raw = JSON.stringify(res.body);
    for (const leaked of [outsider.guestId, outsider.email, outsider.name, insider.guestId]) expect(raw).not.toContain(leaked);
    expect(await prisma.emailSendItem.count({ where: { eventId } })).toBe(0);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: insider.inviteId! } })).lastRemindedAt).toBeNull();
  };

  for (const path of ['/send', '/remind'] as const) {
    it(`${path}: another tenant’s guest`, async () => {
      await refusesWhole(organiser, path, await seed(foreignEventId, foreignOrganiserId, { first: 'Foreign', delivered: true }));
    });

    it(`${path}: an id that is no guest at all`, async () => {
      await refusesWhole(organiser, path, { guestId: randomUUID(), inviteId: null, email: 'none@test.invalid', name: 'Nobody' });
    });

    it(`${path}: a locked member, a guest of a same-tenant event they aren’t assigned`, async () => {
      await refusesWhole(locked, path, await seed(hiddenEventId, organiser.id, { first: 'Hidden', delivered: true }));
    });
  }

  it('a locked member’s guest of an event they ARE assigned is skipped and named, not refused', async () => {
    const insider = await seed(eventId, organiser.id);
    const sibling = await seed(siblingEventId, organiser.id, { first: 'Sibling' });
    const res = await post(locked, '/send', { guestIds: [insider.guestId, sibling.guestId] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ queued: 1, skipped: 1 });
    expectNamedSkips(res.body.data.skippedGuests, { NOT_IN_EVENT: sibling });
  });
});

describe('Remind: the same, alongside the reminder rules', () => {
  it('one waiting guest plus every kind that can’t be sent to: 200, one queued, six named skips', async () => {
    const waiting = await seed(eventId, organiser.id, { delivered: true });
    const { cases } = await seedUnsendable();
    const res = await post(organiser, '/remind', { guestIds: [waiting.guestId, ...Object.values(cases).map((g) => g.guestId)] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ totalSelected: 7, queued: 1, sent: 0, failed: 0, skipped: 6, sendId: expect.any(String) });
    expect(data.queued + data.sent + data.failed + data.skipped).toBe(data.totalSelected);
    expectNamedSkips(data.skippedGuests, cases);
    // Nobody but the waiting guest had a cooldown claimed.
    const mine = [waiting, ...Object.values(cases)].map((g) => g.inviteId).filter((id): id is string => id !== null);
    const claimed = await prisma.invite.findMany({ where: { id: { in: mine }, lastRemindedAt: { not: null } }, select: { id: true } });
    expect(claimed.map((i) => i.id)).toEqual([waiting.inviteId]);
  });

  it('only guests who can’t be reminded, one of each: 422 counting them in the singular, no ids', async () => {
    const removed = await seed(eventId, organiser.id, { archived: true, delivered: true });
    const sibling = await seed(siblingEventId, organiser.id, { delivered: true });
    const res = await post(organiser, '/remind', { guestIds: [removed.guestId, sibling.guestId] });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toBe(
      "No one was reminded: 1 is a guest of another event, 1 was removed from the guest list. Reminders go only to guests who were sent an invitation and haven't responded yet."
    );
  });

  it('two of each: the plural', async () => {
    const removed = [await seed(eventId, organiser.id, { archived: true }), await seed(eventId, organiser.id, { archived: true })];
    const sibling = [await seed(siblingEventId, organiser.id), await seed(siblingEventId, organiser.id)];
    const responded = [await seed(eventId, organiser.id, { delivered: true }), await seed(eventId, organiser.id, { delivered: true })];
    await prisma.invite.updateMany({ where: { id: { in: responded.map((g) => g.inviteId!) } }, data: { status: 'ACCEPTED' } });
    const res = await post(organiser, '/remind', { guestIds: [...removed, ...sibling, ...responded].map((g) => g.guestId) });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.message).toBe(
      'No one was reminded: 2 are guests of another event, 2 were removed from the guest list, 2 have already responded. ' +
        "Reminders go only to guests who were sent an invitation and haven't responded yet."
    );
  });
});

describe('the 422’s counts agree with their number, for every reason', () => {
  const unsendable: Record<UnsendableReason, [string, string]> = {
    NOT_IN_EVENT: ['1 is a guest of another event', '2 are guests of another event'],
    REGISTRATION_DECLINED: ['1 had their registration declined', '2 had their registration declined'],
    ARCHIVED: ['1 was removed from the guest list', '2 were removed from the guest list'],
    PLUS_ONE: ['1 is a plus-one', '2 are plus-ones'],
    PENDING_APPROVAL: ['1 is awaiting your approval', '2 are awaiting your approval'],
    NO_INVITATION: ['1 has no invitation', '2 have no invitation'],
  };
  const reminder: Record<ReminderSkipReason, [string, string]> = {
    ALREADY_RESPONDED: ['1 has already responded', '2 have already responded'],
    NOT_INVITED_YET: ["1 hasn't been sent an invitation yet", "2 haven't been sent an invitation yet"],
    INVITE_EXPIRED: ['1 has an expired invitation', '2 have an expired invitation'],
    RECENTLY_REMINDED: ['1 was reminded in the last 24 hours', '2 were reminded in the last 24 hours'],
    STATE_CHANGED: ['1 changed while sending', '2 changed while sending'],
  };

  for (const [reason, [one, two]] of Object.entries(unsendable) as [UnsendableReason, [string, string]][]) {
    it(`${reason}: 1 and 2`, () => {
      expect(describeUnsendable([reason])).toBe(one);
      expect(describeUnsendable([reason, reason])).toBe(two);
    });
  }
  for (const [reason, [one, two]] of Object.entries(reminder) as [ReminderSkipReason, [string, string]][]) {
    it(`${reason}: 1 and 2`, () => {
      expect(describeSkips([reason])).toBe(one);
      expect(describeSkips([reason, reason])).toBe(two);
    });
  }
});
