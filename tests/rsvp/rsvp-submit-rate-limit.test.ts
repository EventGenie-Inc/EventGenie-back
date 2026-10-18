import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { rsvpSubmitInviteKey, RSVP_SUBMITS_PER_INVITE_PER_HOUR } from '../../src/shared/middleware/rate-limit.middleware.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep } from '../helpers/team.js';

// ─────────────────────────────────────────
//  RSVP SUBMIT — limited per invite (rsvpSubmitInviteLimiter): 20 an hour,
//  counting every request, keyed by the hash of the invite token. This
//  bounds how fast one invite can test addresses against the guest list
//  through the email-change refusal. Its own file: the limiter's store
//  lives for the test process, so no other file shares its budget.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
afterEach(async () => {
  if (tenantIds.length) await deleteTenantsDeep(tenantIds.splice(0));
});

const inviteToken = async (eventId: string, dayId: string, organiserId: string, n: number) => {
  const { invite } = await guestRepository.createWithInvite(eventId, organiserId, {
    firstName: `Guest ${n}`,
    surname: null,
    email: `rate-${n}-${eventId}@test.invalid`,
    phoneNumber: null,
    eventDayIds: [dayId],
    plusOnesAllowed: 0,
  });
  return invite.token;
};

describe('rsvpSubmitInviteKey', () => {
  it('is the hash of the token, never the token', () => {
    const key = rsvpSubmitInviteKey('a'.repeat(64));
    expect(key).toMatch(/^rsvp-invite:[0-9a-f]{64}$/);
    expect(key).not.toContain('a'.repeat(64));
  });
});

describe('per invite', () => {
  it(`the ${RSVP_SUBMITS_PER_INVITE_PER_HOUR + 1}th submit in an hour on one invite is refused, from any IP; another invite is unaffected`, async () => {
    expect(RSVP_SUBMITS_PER_INVITE_PER_HOUR).toBe(20);
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const organiser = await createActor('TENANT_ADMIN', tenant.id);
    const { event, day } = await createEventWithDay(tenant.id, organiser.id);
    const token = await inviteToken(event.id, day.id, organiser.id, 1);
    const other = await inviteToken(event.id, day.id, organiser.id, 2);

    const send = (t: string, i: number) =>
      request(app).post('/api/rsvp/submit').set('X-Forwarded-For', `10.9.${i >> 8}.${i & 255}`).send({ token: t, attending: false });

    for (let i = 0; i < RSVP_SUBMITS_PER_INVITE_PER_HOUR; i++) {
      expect((await send(token, i)).status, `submit ${i + 1}`).toBe(200);
    }
    const refused = await send(token, 999);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      status: 'error',
      message: "You've sent a lot of replies in a short time. Please wait a while and try again.",
    });
    expect((await send(other, 1000)).status).toBe(200);
  }, 300000);
});
