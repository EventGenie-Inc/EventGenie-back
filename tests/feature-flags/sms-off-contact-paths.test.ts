import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { GUEST_EMAIL_REQUIRED_MESSAGE } from '../../src/modules/guest/guest-validation.util.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  LAUNCH MODE — with sms off, nobody ends up reachable only by phone
//  through the two guest-side paths:
//  - public self-registration requires an email;
//  - at RSVP a guest who has an email can't remove it, or swap it for a
//    phone alone. Adding a phone beside the email stays allowed, and a
//    guest who never had an email isn't removing anything.
//  Each is also run with sms ON (the control).
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const phone = () => `+2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const email = () => `sms-off-contact-${randomUUID()}@test.invalid`;

const setupEvent = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const day = await createTestEventDay(event.id, organiser.id);
  cleanup.push(
    async () => {
      const guests = await prisma.guest.findMany({ where: { eventId: event.id }, select: { id: true } });
      for (const g of guests) await deleteTestGuest(g.id);
    },
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  return { tenant, organiser, event, day };
};

describe('sms off — public self-registration', () => {
  const setupPublicEvent = async () => {
    const ctx = await setupEvent();
    const shareToken = `sms-off-${randomUUID()}`;
    await prisma.event.update({ where: { id: ctx.event.id }, data: { visibility: 'PUBLIC', shareToken } });
    const register = (body: Record<string, unknown>) =>
      request(app).post(`/api/public-events/${shareToken}/register`).send({ firstName: 'Reg', ...body });
    return { ...ctx, register };
  };

  // Registration emails the registrant their personal link, so it needs an
  // email whatever the sms flag says (Public events batch); only the wording
  // differs. Was "phone-only is accepted" while registration returned the
  // link in its response.
  it('flag on: phone-only registration is still 422, with wording that doesn\'t mention text messages', async () => {
    const { event, register } = await setupPublicEvent();
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await register({ phoneNumber: phone() });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GUEST_EMAIL_REQUIRED');
    expect(res.body.message).toBe('Enter your email address: your personal link is sent there.');
    expect(await prisma.guest.count({ where: { eventId: event.id } })).toBe(0);
  }, 60000);

  it('flag off: phone-only is 422 and creates no guest; email registration is accepted', async () => {
    const { event, register } = await setupPublicEvent();
    vi.stubEnv('FEATURES_DISABLED', 'sms');

    const refused = await register({ phoneNumber: phone() });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe(GUEST_EMAIL_REQUIRED_MESSAGE);
    expect(await prisma.guest.count({ where: { eventId: event.id } })).toBe(0);

    const ok = await register({ email: email() });
    expect(ok.status).toBe(201);
    expect(await prisma.guest.count({ where: { eventId: event.id } })).toBe(1);
  }, 60000);
});

describe('sms off — RSVP contact update', () => {
  const setupEmailGuest = async () => {
    const ctx = await setupEvent();
    const { guest, invite } = await guestRepository.createWithInvite(ctx.event.id, ctx.organiser.id, {
      firstName: 'Lindi', surname: null, email: email(), phoneNumber: null, eventDayIds: [ctx.day.id], plusOnesAllowed: 0,
    });
    return { ...ctx, guest, invite };
  };
  const submit = (body: Record<string, unknown>) => request(app).post('/api/rsvp/submit').send({ attending: false, ...body });
  const reload = (id: string) => prisma.guest.findUniqueOrThrow({ where: { id } });

  it('flag on: swapping the email for a phone is allowed (the control)', async () => {
    const { guest, invite } = await setupEmailGuest();
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await submit({ token: invite.token, email: null, phoneNumber: phone() });
    expect(res.status).toBe(200);
    expect((await reload(guest.id)).email).toBeNull();
  }, 60000);

  it('flag off: removing the email, or swapping it for a phone, is 422 and nothing changes', async () => {
    const { guest, invite } = await setupEmailGuest();
    vi.stubEnv('FEATURES_DISABLED', 'sms');

    // Give them a phone first, so plain removal would otherwise be allowed
    // (they'd still have one contact): adding a phone beside an email is fine.
    const added = await submit({ token: invite.token, phoneNumber: phone() });
    expect(added.status).toBe(200);
    const withBoth = await reload(guest.id);
    expect(withBoth.email).toBe(guest.email);
    expect(withBoth.phoneNumber).not.toBeNull();

    const removed = await submit({ token: invite.token, email: null });
    expect(removed.status).toBe(422);
    expect(removed.body.message).toBe(GUEST_EMAIL_REQUIRED_MESSAGE);
    // The RSVP form marks the email field from the code (Team Members batch).
    expect(removed.body.code).toBe('GUEST_EMAIL_REQUIRED');

    const swapped = await submit({ token: invite.token, email: null, phoneNumber: phone() });
    expect(swapped.status).toBe(422);
    expect(swapped.body.message).toBe(GUEST_EMAIL_REQUIRED_MESSAGE);
    expect(swapped.body.code).toBe('GUEST_EMAIL_REQUIRED');

    const after = await reload(guest.id);
    expect(after.email).toBe(guest.email);
    expect(after.phoneNumber).toBe(withBoth.phoneNumber);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).deliveryMethod).toBe('EMAIL');
  }, 60000);

  it('flag off: a guest who never had an email can still reply', async () => {
    const ctx = await setupEvent();
    const { guest, invite } = await guestRepository.createWithInvite(ctx.event.id, ctx.organiser.id, {
      firstName: 'Phone', surname: null, email: null, phoneNumber: phone(), eventDayIds: [ctx.day.id], plusOnesAllowed: 0,
    });
    vi.stubEnv('FEATURES_DISABLED', 'sms');
    const res = await submit({ token: invite.token });
    expect(res.status).toBe(200);
    expect((await reload(guest.id)).email).toBeNull();
  }, 60000);
});
