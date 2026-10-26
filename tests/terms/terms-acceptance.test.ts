import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { mockResendSend } from '../setup.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import { issueDeviceToken } from '../../src/modules/auth/device-token.util.js';
import {
  TERMS_VERSION,
  TERMS_NOT_ACCEPTED,
  TERMS_NOT_ACCEPTED_MESSAGE,
  TERMS_VERSION_MISMATCH,
} from '../../src/modules/terms/terms.service.js';
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
//  Terms of Service acceptance: until a user has accepted TERMS_VERSION,
//  every authenticated route is 403 TERMS_NOT_ACCEPTED except /api/terms/*
//  and GET /api/tenants/me (auth.middleware.ts); /api/auth/* and
//  /api/config/features never authenticate at all. Guests are not
//  accounts and never meet it.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let tenantId: string;
const firebaseEmails: Record<string, string> = {};

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  tenantIds.push(tenantId);
}, 60000);

afterAll(async () => {
  await deleteTenantsDeep(tenantIds);
}, 120000);

beforeEach(() => {
  installFirebaseMock(firebaseEmails);
});

const newcomer = (role: Actor['role'] = 'TENANT_ADMIN', tenant: string | null = tenantId) =>
  createActor(role, tenant, { acceptTerms: false });

const status = (actor: Actor) => request(app).get('/api/terms/status').set(headersFor(actor));
const accept = (actor: Actor, version: unknown) =>
  request(app).post('/api/terms/accept').set(headersFor(actor)).send(version === undefined ? {} : { version });
const listEvents = (actor: Actor) => request(app).get('/api/events').set(headersFor(actor));

const expectBlocked = (res: request.Response) => {
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ status: 'error', message: TERMS_NOT_ACCEPTED_MESSAGE, code: TERMS_NOT_ACCEPTED });
};

const actorFromDb = async (userId: string): Promise<Actor> => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { id: u.id, firebaseUid: u.firebaseUid, email: u.email, role: u.role, tenantId: u.tenantId, username: u.username };
};

describe('a user who has not accepted the current Terms', () => {
  it('is blocked from an ordinary route until they accept, then let through', async () => {
    const user = await newcomer();

    expectBlocked(await listEvents(user));

    const before = await status(user);
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ currentVersion: TERMS_VERSION, acceptedVersion: null, acceptedAt: null, mustAccept: true });

    const accepted = await accept(user, TERMS_VERSION);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ currentVersion: TERMS_VERSION, acceptedVersion: TERMS_VERSION, mustAccept: false });
    expect(typeof accepted.body.data.acceptedAt).toBe('string');

    expect((await listEvents(user)).status).toBe(200);
  }, 60000);

  it('a super admin is blocked too', async () => {
    const superAdmin = await newcomer('SUPER_ADMIN', null);
    try {
      expectBlocked(await request(app).get('/api/tenants').set(headersFor(superAdmin)));
      await accept(superAdmin, TERMS_VERSION);
      expect((await request(app).get('/api/tenants').set(headersFor(superAdmin))).status).toBe(200);
    } finally {
      await prisma.user.delete({ where: { id: superAdmin.id } });
    }
  }, 60000);

  it('accepting twice keeps one record, with the first acceptance time', async () => {
    const user = await newcomer();
    const first = await accept(user, TERMS_VERSION);
    const second = await accept(user, TERMS_VERSION);
    expect(second.status).toBe(200);
    expect(second.body.data.acceptedAt).toBe(first.body.data.acceptedAt);
    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(1);
  }, 60000);
});

describe('POST /api/terms/accept — only the current version', () => {
  it('a different version is 409 TERMS_VERSION_MISMATCH, stores nothing, and the user stays blocked', async () => {
    const user = await newcomer();
    const res = await accept(user, '2026-01-01');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(TERMS_VERSION_MISMATCH);
    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
    expectBlocked(await listEvents(user));
  }, 60000);

  it('a missing version is a 400 and stores nothing', async () => {
    const user = await newcomer();
    const res = await accept(user, undefined);
    expect(res.status).toBe(400);
    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
  }, 60000);
});

describe('a version bump', () => {
  it('blocks someone who accepted only an earlier version, until they accept the current one', async () => {
    const user = await newcomer();
    // What everyone holds the day TERMS_VERSION moves on: an acceptance of
    // the version before it.
    await prisma.termsAcceptance.create({ data: { userId: user.id, version: '2000-01-01' } });

    expectBlocked(await listEvents(user));
    const res = await status(user);
    expect(res.body.data).toMatchObject({ currentVersion: TERMS_VERSION, acceptedVersion: '2000-01-01', mustAccept: true });

    await accept(user, TERMS_VERSION);
    expect((await listEvents(user)).status).toBe(200);
    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(2);
  }, 60000);
});

describe('the exempt routes still work before accepting', () => {
  let user: Actor;
  beforeAll(async () => {
    user = await newcomer();
  }, 60000);

  it('GET /api/terms/status', async () => {
    expect((await status(user)).status).toBe(200);
  });

  it('GET /api/tenants/me', async () => {
    const res = await request(app).get('/api/tenants/me').set(headersFor(user));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tenantId);
  });

  it('GET /api/config/features', async () => {
    expect((await request(app).get('/api/config/features')).status).toBe(200);
  });

  it('session exchange, refresh and sign-out', async () => {
    const { token: deviceToken } = await issueDeviceToken(user.id);
    const firebase = headersFor(user).Authorization;

    const exchanged = await request(app).post('/api/auth/exchange-session').set('Authorization', firebase).send({ deviceToken });
    expect(exchanged.status).toBe(200);

    const refreshed = await request(app)
      .post('/api/auth/refresh-session')
      .set('Authorization', firebase)
      .set('X-Session-Token', exchanged.body.data.sessionToken);
    expect(refreshed.status).toBe(200);

    const loggedOut = await request(app).post('/api/auth/logout').send({ deviceToken });
    expect(loggedOut.status).toBe(200);
  }, 60000);

  it('and the route next to /me is not exempt (the control)', async () => {
    expectBlocked(await request(app).get('/api/users').set(headersFor(user)));
  });
});

describe('who it covers', () => {
  it('a new sign-up is blocked until they accept', async () => {
    const uid = `terms-signup-${randomUUID()}`;
    firebaseEmails[uid] = `terms-signup-${randomUUID()}@test.invalid`;
    installFirebaseMock(firebaseEmails);
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer uid:${uid}`)
      .send({ username: 'New Owner', tenantName: `Terms Signup ${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    tenantIds.push(res.body.data.tenant.id);

    const owner = await actorFromDb(res.body.data.user.id);
    expectBlocked(await listEvents(owner));
    await accept(owner, TERMS_VERSION);
    expect((await listEvents(owner)).status).toBe(200);
  }, 60000);

  it('a team member who joined through an invitation is blocked until they accept', async () => {
    const admin = await createActor('TENANT_ADMIN', tenantId);
    const email = `terms-member-${randomUUID()}@test.invalid`;
    const invited = await request(app).post('/api/users/invites').set(headersFor(admin)).send({ email, role: 'EVENT_ADMIN' });
    expect(invited.status).toBe(201);
    const sent = mockResendSend.mock.calls.at(-1)?.[0] as { text: string };
    const token = /\/join\?token=([0-9a-f]{64})/.exec(sent.text)?.[1];

    const uid = `terms-member-${randomUUID()}`;
    firebaseEmails[uid] = email;
    installFirebaseMock(firebaseEmails);
    const joined = await request(app)
      .post('/api/team-invites/accept')
      .set('Authorization', `Bearer uid:${uid}`)
      .send({ token, username: 'New Member' });
    expect(joined.status).toBe(201);

    const member = await actorFromDb((await prisma.user.findUniqueOrThrow({ where: { firebaseUid: uid } })).id);
    expectBlocked(await listEvents(member));
    await accept(member, TERMS_VERSION);
    expect((await listEvents(member)).status).toBe(200);
  }, 60000);

  it('a guest is unaffected, even when the organiser has not accepted', async () => {
    const organiser = await newcomer();
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    const { invite } = await createTestGuestWithInvite(event.id, organiser.id, [day.id]);

    expectBlocked(await listEvents(organiser));
    const res = await request(app).get(`/api/rsvp/validate/${invite.token}`);
    expect(res.status).toBe(200);
  }, 60000);
});
