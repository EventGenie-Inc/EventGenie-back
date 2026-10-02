import { describe, it, expect, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
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
//  RSVP — A GUEST UPDATING THEIR OWN CONTACT
//
//  POST /api/rsvp/submit takes an optional phoneNumber/email: a value sets
//  it (normalised exactly as guest import does — same functions, ZA
//  default — and 422 with import's specific message when invalid), null
//  removes it, omitted/blank leaves it alone. A guest can never remove
//  their only contact (422), and removing the channel their invitation
//  goes out on moves the invite to the one they kept, so future invites
//  and reminders reach them.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

const setupPhoneGuest = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const day = await createTestEventDay(event.id, organiser.id);
  const { guest, invite } = await guestRepository.createWithInvite(event.id, organiser.id, {
    firstName: 'Thandi',
    surname: null,
    email: null,
    phoneNumber: `+2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    eventDayIds: [day.id],
    plusOnesAllowed: 0,
  });
  cleanup.push(
    () => deleteTestGuest(guest.id),
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  return { guest, invite };
};

const submit = (body: Record<string, unknown>) => request(app).post('/api/rsvp/submit').send(body);
const reload = (id: string) => prisma.guest.findUniqueOrThrow({ where: { id } });

describe('RSVP submit — contact update', () => {
  it("updates the guest's phone number, normalised to E.164", async () => {
    const { guest, invite } = await setupPhoneGuest();
    const res = await submit({ token: invite.token, attending: false, phoneNumber: ' +27 82 555 1234 ' });
    expect(res.status).toBe(200);
    expect((await reload(guest.id)).phoneNumber).toBe('+27825551234');
    expect(res.body.data).not.toHaveProperty('guest'); // response shape unchanged
  }, 60000);

  it('an invalid number is 422 with the same specific message guest import gives, and nothing changes', async () => {
    const { guest, invite } = await setupPhoneGuest();
    const bad = await submit({ token: invite.token, attending: false, phoneNumber: 'call me maybe' });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toBe("'call me maybe' is not a valid phone number");

    const local = await submit({ token: invite.token, attending: false, phoneNumber: '0825551234' });
    expect(local.status).toBe(422);
    expect(local.body.message).toBe("'0825551234' is missing a country code, use +27825551234");

    const badEmail = await submit({ token: invite.token, attending: false, email: 'not-an-email' });
    expect(badEmail.status).toBe(422);

    const after = await reload(guest.id);
    expect(after.phoneNumber).toBe(guest.phoneNumber);
    expect(after.email).toBeNull();
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe('PENDING');
  }, 60000);

  it('removing the only contact method is 422, and it is kept', async () => {
    const { guest, invite } = await setupPhoneGuest();
    const res = await submit({ token: invite.token, attending: false, phoneNumber: null });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/at least one way for the organiser to reach you/);
    expect((await reload(guest.id)).phoneNumber).toBe(guest.phoneNumber);

    // Blank is "leave it alone", never a removal — the long-standing rule.
    const blank = await submit({ token: invite.token, attending: false, phoneNumber: '   ' });
    expect(blank.status).toBe(200);
    expect((await reload(guest.id)).phoneNumber).toBe(guest.phoneNumber);
  }, 60000);

  it('swapping phone for email moves the invitation to email, so future sends reach them', async () => {
    const { guest, invite } = await setupPhoneGuest();
    expect(invite.deliveryMethod).toBe('SMS');
    const email = `rsvp-contact-${randomUUID()}@test.invalid`;
    const res = await submit({ token: invite.token, attending: false, email: email.toUpperCase(), phoneNumber: null });
    expect(res.status).toBe(200);
    expect(await reload(guest.id)).toMatchObject({ email, phoneNumber: null });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).deliveryMethod).toBe('EMAIL');
  }, 60000);
});
