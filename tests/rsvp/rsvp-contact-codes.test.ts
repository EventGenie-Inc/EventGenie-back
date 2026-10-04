import { describe, it, expect, afterEach, afterAll } from 'vitest';
import request from 'supertest';
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
//  RSVP CONTACT ERRORS CARRY MACHINE-READABLE CODES
//
//  POST /api/rsvp/submit's contact refusals are all 422, so the client
//  can't tell which field to mark from the status alone. Each now carries
//  a code (STEERING "Machine-readable codes"), with the message unchanged:
//  CONTACT_PHONE_INVALID, CONTACT_PHONE_NOT_INTERNATIONAL,
//  CONTACT_LAST_REMOVED. Nothing about the guest changes on a refusal.
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

describe('RSVP submit — contact error codes', () => {
  it('each contact refusal has its code and its existing message', async () => {
    const { guest, invite } = await setupPhoneGuest();
    const base = { token: invite.token, attending: false };

    const garbage = await submit({ ...base, phoneNumber: 'call me maybe' });
    expect(garbage.status).toBe(422);
    expect(garbage.body).toEqual({
      status: 'error',
      message: "'call me maybe' is not a valid phone number",
      code: 'CONTACT_PHONE_INVALID',
    });

    const local = await submit({ ...base, phoneNumber: '0825551234' });
    expect(local.status).toBe(422);
    expect(local.body).toEqual({
      status: 'error',
      message: "'0825551234' is missing a country code, use +27825551234",
      code: 'CONTACT_PHONE_NOT_INTERNATIONAL',
    });

    const lastRemoved = await submit({ ...base, phoneNumber: null });
    expect(lastRemoved.status).toBe(422);
    expect(lastRemoved.body).toEqual({
      status: 'error',
      message: 'Please keep at least one way for the organiser to reach you — an email address or a phone number.',
      code: 'CONTACT_LAST_REMOVED',
    });

    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).phoneNumber).toBe(guest.phoneNumber);
  }, 60000);

  it('an invalid email keeps its plain response, with no code (not asked for)', async () => {
    const { invite } = await setupPhoneGuest();
    const res = await submit({ token: invite.token, attending: false, email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body).not.toHaveProperty('code');
  }, 60000);
});
