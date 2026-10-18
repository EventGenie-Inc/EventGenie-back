import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, freshEmail, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  ALLOWED DOMAINS AT RSVP — on a public event with allowed email domains,
//  a guest changing their email at RSVP to an address outside them gets
//  the refusal registration gives (422 REGISTRATION_EMAIL_DOMAIN, the same
//  message). Otherwise a registrant could register at the company address
//  and swap it afterwards. Only a change is checked.
// ─────────────────────────────────────────

afterEach(cleanupPublicEventFixtures);

const submit = (body: Record<string, unknown>) => request(app).post('/api/rsvp/submit').send({ attending: false, ...body });

const registrant = async (shareToken: string, eventId: string, email: string) => {
  expect((await register(shareToken, { email })).status).toBe(201);
  const guest = await prisma.guest.findFirstOrThrow({ where: { eventId, email } });
  const { token } = await prisma.invite.findFirstOrThrow({ where: { guestId: guest.id } });
  return { guest, token };
};

describe('changing email at RSVP on a public event with allowed domains', () => {
  it('to an address outside them is refused exactly as registration refuses it, and nothing changes', async () => {
    const ev = await createPublicEvent({ event: { registrationEmailDomains: ['company.co.za', 'partner.co.za'] } });
    const own = freshEmail('company.co.za');
    const { guest, token } = await registrant(ev.shareToken, ev.eventId, own);

    const atRegistration = await register(ev.shareToken, { email: 'someone@gmail.com' });
    for (const email of ['someone@gmail.com', 'someone@mail.company.co.za', '  Someone@NotCompany.co.za ']) {
      const res = await submit({ token, email });
      expect(res.status, email).toBe(422);
      expect(res.body).toEqual({
        status: 'error',
        code: 'REGISTRATION_EMAIL_DOMAIN',
        message: 'Register with an email address at company.co.za or partner.co.za.',
      });
      expect(res.body).toEqual(atRegistration.body);
    }
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).email).toBe(own);

    // Inside the domains (normalised first) is accepted.
    const ok = await submit({ token, email: '  New.Address@PARTNER.co.za ' });
    expect(ok.status).toBe(200);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).email).toBe('new.address@partner.co.za');
  }, 60000);

  it('an address the guest already has, from before the domains were set, never blocks their reply', async () => {
    const ev = await createPublicEvent();
    const own = freshEmail('gmail.com');
    const { token } = await registrant(ev.shareToken, ev.eventId, own);
    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationEmailDomains: ['company.co.za'] } });

    expect((await submit({ token })).status).toBe(200);
    expect((await submit({ token, email: own.toUpperCase() })).status).toBe(200);
    expect((await submit({ token, email: freshEmail('gmail.com') })).body.code).toBe('REGISTRATION_EMAIL_DOMAIN');
  }, 60000);

  it('a public event with no domains accepts any address', async () => {
    const ev = await createPublicEvent();
    const { token } = await registrant(ev.shareToken, ev.eventId, freshEmail());
    expect((await submit({ token, email: freshEmail('gmail.com') })).status).toBe(200);
  }, 60000);
});
