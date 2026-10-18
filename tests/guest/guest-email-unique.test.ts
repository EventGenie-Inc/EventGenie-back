import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import request from 'supertest';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { eventPublicRepository } from '../../src/modules/event-public/event-public.repository.js';
import { isGuestEmailUniqueViolation, GUEST_EMAIL_UNIQUE_INDEX } from '../../src/modules/guest/guest-validation.util.js';
import { createPublicEvent, register, cleanupPublicEventFixtures } from '../public-events/helpers.js';

// ─────────────────────────────────────────
//  SMALL GUEST FIXES
//
//  - RSVP naming more plus-ones than the allowance: 422
//    PLUS_ONES_OVER_ALLOWANCE (was an uncoded 400).
//  - Adding a guest with an email another guest on the event has: 409
//    GUEST_EMAIL_TAKEN, the same as editing.
//  - The database guarantee: a partial unique index on (eventId,
//    lower(email)) over live guests. Its migration refuses to run while
//    duplicates exist. A violation (two writes racing past the app's own
//    check, simulated here by making the check miss) is each path's own
//    refusal, never a 500.
// ─────────────────────────────────────────

// A deep cleanup is ~25 round trips to the remote test database: more than
// the default 10-second hook timeout allows on a slow day.
const tenantIds: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (tenantIds.length) await deleteTenantsDeep(tenantIds.splice(0));
  await cleanupPublicEventFixtures();
}, 60000);

const email = () => `unique-${randomUUID()}@test.invalid`;

const setup = async () => {
  installFirebaseMock();
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, organiser.id);
  return { organiser, event, day };
};

type Ctx = Awaited<ReturnType<typeof setup>>;

const createGuest = (ctx: Ctx, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/events/${ctx.event.id}/guests`)
    .set(headersFor(ctx.organiser))
    .send({ firstName: 'Guest', eventDayIds: [ctx.day.id], ...body });

const updateGuest = (organiser: Actor, id: string, body: Record<string, unknown>) =>
  request(app).put(`/api/guests/${id}`).set(headersFor(organiser)).send(body);

const TAKEN = {
  status: 'error',
  message: 'Another guest on this event already has this email address.',
  code: 'GUEST_EMAIL_TAKEN',
};

describe('RSVP: more plus-ones than the allowance', () => {
  it('is 422 PLUS_ONES_OVER_ALLOWANCE, and nothing is saved; the allowance itself is fine', async () => {
    const ctx = await setup();
    const created = await createGuest(ctx, { email: email(), plusOnesAllowed: 1 });
    const guestId = created.body.data.id as string;
    const { token } = await prisma.invite.findFirstOrThrow({ where: { guestId } });

    const res = await request(app)
      .post('/api/rsvp/submit')
      .send({ token, attending: true, attendingDayIds: [ctx.day.id], plusOneNames: ['Lebo', 'Sipho'] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message: 'You can bring up to 1 plus-one(s). Please remove some and try again.',
      code: 'PLUS_ONES_OVER_ALLOWANCE',
    });
    expect(await prisma.guest.count({ where: { hostGuestId: guestId } })).toBe(0);
    expect((await prisma.invite.findFirstOrThrow({ where: { guestId } })).status).toBe('PENDING');

    const ok = await request(app)
      .post('/api/rsvp/submit')
      .send({ token, attending: true, attendingDayIds: [ctx.day.id], plusOneNames: ['Lebo'] });
    expect(ok.status).toBe(200);
  }, 60000);
});

describe('organiser add: an email another guest on the event has', () => {
  it('is 409 GUEST_EMAIL_TAKEN in any casing, like an edit; another event or an archived guest is no conflict', async () => {
    const ctx = await setup();
    const taken = email();
    const first = await createGuest(ctx, { email: taken });
    expect(first.status).toBe(201);

    for (const tried of [taken, `  ${taken.toUpperCase()} `]) {
      const res = await createGuest(ctx, { email: tried });
      expect(res.status).toBe(409);
      expect(res.body).toEqual(TAKEN);
    }
    expect(await prisma.guest.count({ where: { eventId: ctx.event.id } })).toBe(1);

    const other = await createEventWithDay(ctx.organiser.tenantId!, ctx.organiser.id);
    const elsewhere = await request(app)
      .post(`/api/events/${other.event.id}/guests`)
      .set(headersFor(ctx.organiser))
      .send({ firstName: 'Guest', eventDayIds: [other.day.id], email: taken });
    expect(elsewhere.status).toBe(201);

    await prisma.guest.update({ where: { id: first.body.data.id }, data: { isArchived: true } });
    expect((await createGuest(ctx, { email: taken })).status).toBe(201);
  }, 60000);
});

describe('the unique index', () => {
  it('refuses a second live guest with the same email (any casing) on one event, and nothing else', async () => {
    const ctx = await setup();
    const address = email();
    const row = (data: Record<string, unknown>) =>
      prisma.guest.create({ data: { eventId: ctx.event.id, firstName: 'Raw', ...data } });

    await row({ email: address });
    const err = await row({ email: address.toUpperCase() }).catch((e: unknown) => e);
    expect(isGuestEmailUniqueViolation(err)).toBe(true);

    // Archived, emailless, or on another event: allowed.
    await row({ email: address, isArchived: true });
    await row({ email: null, phoneNumber: '+27825550010' });
    await row({ email: null, phoneNumber: '+27825550010' });
    const other = await createEventWithDay(ctx.organiser.tenantId!, ctx.organiser.id);
    await prisma.guest.create({ data: { eventId: other.event.id, firstName: 'Raw', email: address } });
  }, 60000);

  it('organiser create racing past the check: 409 GUEST_EMAIL_TAKEN, never a 500', async () => {
    const ctx = await setup();
    const address = email();
    await createGuest(ctx, { email: address });
    vi.spyOn(guestRepository, 'findContactsForEvent').mockResolvedValueOnce([]);
    const res = await createGuest(ctx, { email: address });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(TAKEN);
    expect(await prisma.guest.count({ where: { eventId: ctx.event.id } })).toBe(1);
  }, 60000);

  it('organiser edit racing past the check: 409 GUEST_EMAIL_TAKEN', async () => {
    const ctx = await setup();
    const address = email();
    await createGuest(ctx, { email: address });
    const b = await createGuest(ctx, { email: email() });
    vi.spyOn(guestRepository, 'isEmailUsedByOtherGuest').mockResolvedValueOnce(false);
    const res = await updateGuest(ctx.organiser, b.body.data.id, { email: address });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(TAKEN);
  }, 60000);

  it('restoring an archived guest whose email a live guest now has: 409 GUEST_EMAIL_TAKEN', async () => {
    const ctx = await setup();
    const address = email();
    const a = await createGuest(ctx, { email: address });
    expect((await request(app).delete(`/api/guests/${a.body.data.id}`).set(headersFor(ctx.organiser))).status).toBe(200);
    expect((await createGuest(ctx, { email: address })).status).toBe(201);

    const res = await request(app).post(`/api/guests/${a.body.data.id}/reactivate`).set(headersFor(ctx.organiser));
    expect(res.status).toBe(409);
    expect(res.body).toEqual(TAKEN);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: a.body.data.id } })).isArchived).toBe(true);
  }, 60000);

  it('RSVP email change racing past the check: the neutral 422 CONTACT_EMAIL_UNAVAILABLE', async () => {
    const ctx = await setup();
    const address = email();
    await createGuest(ctx, { email: address });
    const b = await createGuest(ctx, { email: email() });
    const { token } = await prisma.invite.findFirstOrThrow({ where: { guestId: b.body.data.id } });
    vi.spyOn(guestRepository, 'isEmailUsedByOtherGuest').mockResolvedValueOnce(false);
    const res = await request(app).post('/api/rsvp/submit').send({ token, attending: false, email: address });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message: "That email address can't be used for this invitation. Please use another one.",
      code: 'CONTACT_EMAIL_UNAVAILABLE',
    });
  }, 60000);

  it("self-registration racing an organiser's add: the ordinary couldn't-send answer, one guest", async () => {
    const fx = await createPublicEvent();
    const address = email();
    await prisma.guest.create({ data: { eventId: fx.eventId, firstName: 'Added', email: address } });
    vi.spyOn(eventPublicRepository, 'findGuestByEmail').mockResolvedValueOnce(null);
    const res = await register(fx.shareToken, { email: address });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      outcome: 'REGISTERED',
      emailSent: false,
      message: "We couldn't send your email just now. Register again with the same email address in a few minutes and we'll send it.",
    });
    expect(await prisma.guest.count({ where: { eventId: fx.eventId, email: address } })).toBe(1);
  }, 60000);
});

describe('the migration', () => {
  it('refuses to run while duplicates exist, saying what to do, and applies nothing', async () => {
    const ctx = await setup();
    const sql = readFileSync('prisma/migrations/20261009091000_guest_email_unique/migration.sql', 'utf8');
    const address = email();

    // Rehearsed inside a transaction that is always rolled back: the index
    // is dropped, two duplicates written, then the migration run as is.
    const outcome = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX "${GUEST_EMAIL_UNIQUE_INDEX}"`);
        await tx.guest.create({ data: { eventId: ctx.event.id, firstName: 'Dup', email: address } });
        await tx.guest.create({ data: { eventId: ctx.event.id, firstName: 'Dup', email: address.toUpperCase() } });
        let migrationError: unknown = null;
        try {
          await tx.$executeRawUnsafe(sql);
        } catch (e) {
          migrationError = e;
        }
        throw Object.assign(new Error('rollback'), { migrationError });
      }, { timeout: 30_000 })
      .catch((e: { migrationError?: unknown }) => e.migrationError);

    expect(String((outcome as Error | null)?.message ?? outcome)).toMatch(/report-guest-email-duplicates/);
    // Rolled back: the index is back, the duplicates never existed.
    const index = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE indexname = ${GUEST_EMAIL_UNIQUE_INDEX}`;
    expect(index).toHaveLength(1);
    expect(await prisma.guest.count({ where: { eventId: ctx.event.id } })).toBe(0);
  }, 60000);
});
