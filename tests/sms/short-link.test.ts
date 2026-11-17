import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import {
  inviteShortCodeService,
  generateShortCode,
  shortLinkFor,
  SHORT_CODE_LENGTH,
} from '../../src/modules/invite/invite-short-code.service.js';
import { SHORT_LINK_FAILURES_PER_IP_PER_15_MIN } from '../../src/shared/middleware/rate-limit.middleware.js';
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
//  SHORT LINKS — a text message carries <site>/r/<code> instead of the
//  98-character /rsvp?token= link. The code: 10 random letters and digits,
//  unique, created the first time it is needed and never changed. POST
//  /api/rsvp/short-link swaps it for the token, refused exactly as a token
//  is (an unknown code, a removed, pending or declined guest's, an archived
//  invite's: the same 404), and limited against guessing.
// ─────────────────────────────────────────

const UNKNOWN = {
  status: 'error',
  message: "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.",
};

let ipNo = 0;
const resolve = (code: unknown, ip = `198.51.100.${(++ipNo % 250) + 1}`) =>
  request(app).post('/api/rsvp/short-link').set('X-Forwarded-For', ip).send({ code });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const setup = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const day = await createTestEventDay(event.id, organiser.id);
  const guestIds: string[] = [];
  cleanup.push(
    async () => { for (const id of guestIds) await deleteTestGuest(id); },
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  const addGuest = async (phoneNumber = '+27825550601') => {
    const created = await guestRepository.createWithInvite(event.id, organiser.id, {
      firstName: 'Short', surname: 'Link', email: null, phoneNumber, eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    guestIds.push(created.guest.id);
    return created;
  };
  return { event, addGuest };
};

describe('the code', () => {
  it('is 10 letters and digits, random each time', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateShortCode));
    expect(codes.size).toBe(1000);
    for (const code of codes) expect(code).toMatch(new RegExp(`^[A-Za-z0-9]{${SHORT_CODE_LENGTH}}$`));
    expect(SHORT_CODE_LENGTH).toBeGreaterThanOrEqual(10);
  });

  it('is created when first needed, stored with the invite, and never changed', async () => {
    const { addGuest } = await setup();
    const { invite } = await addGuest();
    expect(invite.shortCode).toBeNull();

    const code = await inviteShortCodeService.ensure(invite.id, null);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).shortCode).toBe(code);
    // A second caller that read the invite before the code was written
    // (existing: null) gets the first code; it is never replaced.
    expect(await inviteShortCodeService.ensure(invite.id, null)).toBe(code);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).shortCode).toBe(code);
  }, 60000);

  it('is unique: a code another invite already has is drawn again', async () => {
    const { addGuest } = await setup();
    const a = await addGuest('+27825550602');
    const b = await addGuest('+27825550603');
    const taken = generateShortCode();
    const fresh = generateShortCode();
    await inviteShortCodeService.ensure(a.invite.id, null, () => taken);

    const draws = [taken, fresh];
    const code = await inviteShortCodeService.ensure(b.invite.id, null, () => draws.shift()!);
    expect(code).toBe(fresh);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: b.invite.id } })).shortCode).toBe(fresh);
    // And the database itself refuses a second invite with the same code.
    await expect(prisma.invite.update({ where: { id: b.invite.id }, data: { shortCode: taken } })).rejects.toMatchObject({ code: 'P2002' });
  }, 60000);

  it('the short link is <FRONTEND_BASE_URL>/r/<code>', () => {
    expect(shortLinkFor('AbC123xYz9')).toBe(`${process.env.FRONTEND_BASE_URL!.replace(/\/+$/, '')}/r/AbC123xYz9`);
  });
});

describe('POST /api/rsvp/short-link', () => {
  it('answers the invite token, never cached', async () => {
    const { addGuest } = await setup();
    const { invite } = await addGuest();
    const code = await inviteShortCodeService.ensure(invite.id, null);
    const res = await resolve(code);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { token: invite.token } });
    expect(res.headers['cache-control']).toBe('no-store');
  }, 60000);

  it('a removed, pending or declined guest, or an archived invite, gets the unknown answer', async () => {
    const { addGuest } = await setup();
    const cases: [string, (inviteId: string, guestId: string) => Promise<unknown>][] = [
      ['removed guest', (_i, g) => prisma.guest.update({ where: { id: g }, data: { isArchived: true } })],
      ['pending approval', (_i, g) => prisma.guest.update({ where: { id: g }, data: { pendingApproval: true } })],
      ['declined registration', (_i, g) => prisma.guest.update({ where: { id: g }, data: { registrationDeclinedAt: new Date() } })],
      ['archived invite', (i) => prisma.invite.update({ where: { id: i }, data: { isArchived: true } })],
    ];
    const unknown = await resolve(generateShortCode());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(UNKNOWN);

    for (const [label, shutOut] of cases) {
      const { guest, invite } = await addGuest();
      const code = await inviteShortCodeService.ensure(invite.id, null);
      expect((await resolve(code)).status, `${label} before`).toBe(200);
      await shutOut(invite.id, guest.id);
      const res = await resolve(code);
      expect(res.status, label).toBe(404);
      expect(res.body, label).toEqual(UNKNOWN);
    }
  }, 60000);

  it('an archived event is 410, a malformed code the unknown answer, no code a 400', async () => {
    const { event, addGuest } = await setup();
    const { invite } = await addGuest();
    const code = await inviteShortCodeService.ensure(invite.id, null);

    expect((await resolve('short')).body).toEqual(UNKNOWN);
    expect((await resolve(`${code}x`)).status).toBe(404);
    expect((await resolve(undefined)).status).toBe(400);

    await prisma.event.update({ where: { id: event.id }, data: { isArchived: true } });
    const archived = await resolve(code);
    expect(archived.status).toBe(410);
    expect(archived.body.data).toBeUndefined();
    await prisma.event.update({ where: { id: event.id }, data: { isArchived: false } });
  }, 60000);

  it('guessing is limited per IP; a guest opening their own link is not', async () => {
    const { addGuest } = await setup();
    const { invite } = await addGuest();
    const code = await inviteShortCodeService.ensure(invite.id, null);
    const ip = '203.0.113.77';

    for (let i = 0; i < SHORT_LINK_FAILURES_PER_IP_PER_15_MIN; i++) {
      expect((await resolve(generateShortCode(), ip)).status).toBe(404);
    }
    expect((await resolve(generateShortCode(), ip)).status).toBe(429);
    // The guest's own link from another network still opens.
    expect((await resolve(code, '203.0.113.78')).status).toBe(200);
  }, 60000);
});
