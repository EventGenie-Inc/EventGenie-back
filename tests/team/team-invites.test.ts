import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { mockResendSend, mockVerifyIdToken } from '../setup.js';
import { hashToken } from '../../src/modules/auth/device-token.util.js';
import {
  createTenant,
  createActor,
  installFirebaseMock,
  headersFor,
  createEventWithDay,
  deleteTenantsDeep,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  TEAM INVITATIONS (Team Members batch): POST /api/users/invites and
//  friends (TENANT_ADMIN), POST /api/team-invites/lookup|accept (public).
//
//  An invite can't be accepted twice, after expiry, by a different email,
//  or by an email that already has an account; emails match in any case;
//  the raw token is never stored and never logged.
// ─────────────────────────────────────────

let tenantId: string;
let admin: Actor;
let eventId: string;
const companyName = `Acme HR ${randomUUID().slice(0, 6)}`;
const logged: string[] = [];

beforeAll(async () => {
  tenantId = (await createTenant(companyName)).id;
  admin = await createActor('TENANT_ADMIN', tenantId);
  eventId = (await createEventWithDay(tenantId, admin.id, 'Year-end function')).event.id;
}, 60000);

afterAll(async () => {
  await deleteTenantsDeep([tenantId]);
}, 120000);

beforeEach(() => {
  installFirebaseMock(firebaseEmails);
  logged.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Firebase accounts the accept tests sign in as: uid → email on the token.
const firebaseEmails: Record<string, string> = {};
const firebaseAccount = (email: string) => {
  const uid = `invitee-${randomUUID()}`;
  firebaseEmails[uid] = email;
  installFirebaseMock(firebaseEmails);
  return `uid:${uid}`;
};

const lastEmailedToken = (): string => {
  const sent = mockResendSend.mock.calls.at(-1)?.[0] as { html: string; text: string };
  const match = /\/join\?token=([0-9a-f]{64})/.exec(sent.text);
  if (!match?.[1]) throw new Error('no invitation link in the last email');
  return match[1];
};

const invite = async (body: Record<string, unknown>) => {
  installFirebaseMock(firebaseEmails);
  return request(app).post('/api/users/invites').set(headersFor(admin)).send(body);
};

const accept = (firebaseToken: string, token: string, username = 'New Person') =>
  request(app).post('/api/team-invites/accept').set({ Authorization: `Bearer ${firebaseToken}` }).send({ token, username });

const freshEmail = (prefix = 'invitee') => `${prefix}-${randomUUID().slice(0, 8)}@test.invalid`;

describe('creating an invite', () => {
  it('stores the email lowercased, only the token hash, a 7-day expiry, and sends the layout email', async () => {
    const email = freshEmail('Mixed.Case');
    const before = Date.now();
    const res = await invite({ email: `  ${email.toUpperCase()} `, role: 'EVENT_ADMIN', eventIds: [eventId] });
    expect(res.status).toBe(201);
    expect(res.body.data.emailSent).toBe(true);
    expect(res.body.data.invite).toMatchObject({
      email: email.toLowerCase(),
      role: 'EVENT_ADMIN',
      status: 'PENDING',
      assignments: [{ eventId, eventName: 'Year-end function' }],
    });

    const sent = mockResendSend.mock.calls.at(-1)?.[0] as { subject: string; html: string; text: string; to: string };
    expect(sent.to).toBe(email.toLowerCase());
    expect(sent.subject).toBe(`You've been invited to join ${companyName} on e-velope`);
    expect(sent.html).toContain('data-eg-email-layout="1"');
    expect(sent.html).toContain('Accept invitation');
    const raw = lastEmailedToken();
    expect(sent.text).toContain(`${process.env.FRONTEND_BASE_URL}/join?token=${raw}`);

    const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: res.body.data.invite.id } });
    expect(row.tokenHash).toBe(hashToken(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(JSON.stringify(res.body)).not.toContain(raw);
    const ttlDays = (row.expiresAt.getTime() - before) / 86400000;
    expect(ttlDays).toBeGreaterThan(6.99);
    expect(ttlDays).toBeLessThan(7.01);
    expect(logged.join('\n')).not.toContain(raw);
  }, 60000);

  it('refuses an email that already has an account (409 USER_EMAIL_TAKEN) and a second open invite (409 TEAM_INVITE_PENDING)', async () => {
    const existing = await invite({ email: admin.email.toUpperCase(), role: 'EVENT_ADMIN' });
    expect(existing.status).toBe(409);
    expect(existing.body.code).toBe('USER_EMAIL_TAKEN');

    const email = freshEmail();
    expect((await invite({ email, role: 'EVENT_ADMIN' })).status).toBe(201);
    const again = await invite({ email: email.toUpperCase(), role: 'TENANT_ADMIN' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TEAM_INVITE_PENDING');
  }, 60000);

  it('refuses event assignments for a tenant admin (422) and a vendor role (422)', async () => {
    expect((await invite({ email: freshEmail(), role: 'TENANT_ADMIN', eventIds: [eventId] })).status).toBe(422);
    expect((await invite({ email: freshEmail(), role: 'EVENT_VENDOR' })).status).toBe(422);
  }, 60000);

  it('is TENANT_ADMIN only', async () => {
    const member = await createActor('EVENT_ADMIN', tenantId);
    const res = await request(app).post('/api/users/invites').set(headersFor(member)).send({ email: freshEmail(), role: 'EVENT_ADMIN' });
    expect(res.status).toBe(403);
  }, 60000);
});

describe('accepting an invite', () => {
  it('creates the user in the inviting tenant with the role and assignments; the Firebase email may differ in case', async () => {
    const email = freshEmail();
    const created = await invite({ email, role: 'EVENT_ADMIN', eventIds: [eventId] });
    expect(created.status).toBe(201);
    const raw = lastEmailedToken();

    const lookup = await request(app).post('/api/team-invites/lookup').send({ token: raw });
    expect(lookup.status).toBe(200);
    expect(lookup.body.data).toEqual({ email, companyName, role: 'EVENT_ADMIN', expiresAt: expect.any(String) });

    const res = await accept(firebaseAccount(email.toUpperCase()), raw);
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email, role: 'EVENT_ADMIN', tenantId, username: 'New Person' });
    expect(res.body.data.tenant).toEqual({ id: tenantId, name: companyName });

    const assignments = await prisma.eventAssignment.findMany({ where: { userId: res.body.data.user.id } });
    expect(assignments.map((a) => a.eventId)).toEqual([eventId]);
    const row = await prisma.teamInvite.findUniqueOrThrow({ where: { id: created.body.data.invite.id } });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedUserId).toBe(res.body.data.user.id);
    expect(logged.join('\n')).not.toContain(raw);
  }, 60000);

  it("can't be accepted twice (409 TEAM_INVITE_USED)", async () => {
    const email = freshEmail();
    await invite({ email, role: 'EVENT_ADMIN' });
    const raw = lastEmailedToken();
    const firebaseToken = firebaseAccount(email);
    expect((await accept(firebaseToken, raw)).status).toBe(201);

    const second = await accept(firebaseAccount(email), raw);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TEAM_INVITE_USED');
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(logged.join('\n')).not.toContain(raw);
  }, 60000);

  it("can't be accepted after it expires (422 TEAM_INVITE_EXPIRED)", async () => {
    const email = freshEmail();
    const created = await invite({ email, role: 'EVENT_ADMIN' });
    const raw = lastEmailedToken();
    await prisma.teamInvite.update({ where: { id: created.body.data.invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await accept(firebaseAccount(email), raw);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEAM_INVITE_EXPIRED');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  }, 60000);

  it("can't be accepted by a different email (403)", async () => {
    const email = freshEmail();
    await invite({ email, role: 'EVENT_ADMIN' });
    const raw = lastEmailedToken();

    const res = await accept(firebaseAccount(freshEmail('someone-else')), raw);
    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  }, 60000);

  it("can't be accepted by an email that has an account by now (409 USER_EMAIL_TAKEN)", async () => {
    const email = freshEmail();
    await invite({ email, role: 'EVENT_ADMIN' });
    const raw = lastEmailedToken();
    // The address got an account somewhere after the invite was sent.
    const otherTenantId = (await createTenant()).id;
    const elsewhere = await prisma.user.create({
      data: { firebaseUid: `elsewhere-${randomUUID()}`, email, username: 'Elsewhere', role: 'EVENT_ADMIN', tenantId: otherTenantId },
    });

    const res = await accept(firebaseAccount(email), raw);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_EMAIL_TAKEN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: elsewhere.id } })).tenantId).toBe(otherTenantId);
    await deleteTenantsDeep([otherTenantId]);
  }, 60000);
});

describe('accept and the Firebase token', () => {
  it('a rejected Firebase token is 401; a Firebase failure that is not about the token stays a 500', async () => {
    const email = freshEmail();
    await invite({ email, role: 'EVENT_ADMIN' });
    const raw = lastEmailedToken();

    mockVerifyIdToken.mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 'auth/id-token-expired' }));
    const expired = await accept('any-token', raw);
    expect(expired.status).toBe(401);

    mockVerifyIdToken.mockRejectedValueOnce(Object.assign(new Error('outage'), { code: 'app/network-error' }));
    const outage = await accept('any-token', raw);
    expect(outage.status).toBe(500);

    // Neither consumed the invite.
    expect((await request(app).post('/api/team-invites/lookup').send({ token: raw })).status).toBe(200);
  }, 60000);
});

describe('resend and revoke', () => {
  it('resend mints a new token: the old link stops working, the new one works', async () => {
    const email = freshEmail();
    const created = await invite({ email, role: 'EVENT_ADMIN' });
    const oldRaw = lastEmailedToken();

    const resent = await request(app).post(`/api/users/invites/${created.body.data.invite.id}/resend`).set(headersFor(admin));
    expect(resent.status).toBe(200);
    const newRaw = lastEmailedToken();
    expect(newRaw).not.toBe(oldRaw);

    const old = await request(app).post('/api/team-invites/lookup').send({ token: oldRaw });
    expect(old.status).toBe(404);
    expect(old.body.code).toBe('TEAM_INVITE_INVALID');
    expect((await request(app).post('/api/team-invites/lookup').send({ token: newRaw })).status).toBe(200);
    expect(logged.join('\n')).not.toContain(newRaw);
  }, 60000);

  it('a revoked invite is gone from the list and its link is invalid', async () => {
    const email = freshEmail();
    const created = await invite({ email, role: 'EVENT_ADMIN' });
    const raw = lastEmailedToken();
    const id = created.body.data.invite.id;

    expect((await request(app).post(`/api/users/invites/${id}/revoke`).set(headersFor(admin))).status).toBe(200);
    const list = await request(app).get('/api/users/invites').set(headersFor(admin));
    expect(list.body.data.map((i: { id: string }) => i.id)).not.toContain(id);
    expect((await accept(firebaseAccount(email), raw)).body.code).toBe('TEAM_INVITE_INVALID');
  }, 60000);
});
