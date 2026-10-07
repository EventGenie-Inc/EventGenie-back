import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { userRepository } from '../../src/modules/user/user.repository.js';
import {
  userService,
  LAST_TENANT_ADMIN_DEMOTE_MESSAGE,
  LAST_TENANT_ADMIN_SUSPEND_MESSAGE,
  SELF_SUSPEND_MESSAGE,
  VENDOR_ROLE_UNAVAILABLE_MESSAGE,
} from '../../src/modules/user/user.service.js';
import {
  createTenant,
  createActor,
  installFirebaseMock,
  headersFor,
  createEventWithDay,
  assign,
  deleteTenantsDeep,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  Team roles on /api/users (Team Members batch): a tenant always keeps one
//  active TENANT_ADMIN (409), nobody suspends themselves (403), with
//  vendors off a CHANGE to EVENT_VENDOR is 422, PUT writes only username
//  and role, a promotion clears assignments, and a TENANT_ADMIN can now
//  suspend, see and reactivate their own members.
// ─────────────────────────────────────────

let tenantIds: string[] = [];
let superAdmin: Actor;

beforeEach(async () => {
  installFirebaseMock();
  tenantIds = [];
  superAdmin = await createActor('SUPER_ADMIN', null);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await deleteTenantsDeep(tenantIds);
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120000);

const newTenant = async () => {
  const t = await createTenant();
  tenantIds.push(t.id);
  return t.id;
};

describe('the last active TENANT_ADMIN', () => {
  it("can't be demoted (409), even by a SUPER_ADMIN; with a second admin it can", async () => {
    const tenantId = await newTenant();
    const only = await createActor('TENANT_ADMIN', tenantId);

    const refused = await request(app).put(`/api/users/${only.id}`).set(headersFor(superAdmin)).send({ role: 'EVENT_ADMIN' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe(LAST_TENANT_ADMIN_DEMOTE_MESSAGE);
    expect((await prisma.user.findUnique({ where: { id: only.id } }))?.role).toBe('TENANT_ADMIN');

    await createActor('TENANT_ADMIN', tenantId);
    const allowed = await request(app).put(`/api/users/${only.id}`).set(headersFor(superAdmin)).send({ role: 'EVENT_ADMIN' });
    expect(allowed.status).toBe(200);
  }, 60000);

  it("can't be suspended (409) on either suspend route", async () => {
    const tenantId = await newTenant();
    const only = await createActor('TENANT_ADMIN', tenantId);

    const viaSuspend = await request(app).post(`/api/users/${only.id}/suspend`).set(headersFor(superAdmin));
    expect(viaSuspend.status).toBe(409);
    expect(viaSuspend.body.message).toBe(LAST_TENANT_ADMIN_SUSPEND_MESSAGE);
    const viaDelete = await request(app).delete(`/api/users/${only.id}`).set(headersFor(superAdmin));
    expect(viaDelete.status).toBe(409);
    const row = await prisma.user.findUnique({ where: { id: only.id } });
    expect(row?.isActive).toBe(true);
    expect(row?.isArchived).toBe(false);
  }, 60000);

  it('two admins demoting each other over HTTP: one succeeds, and the tenant keeps an admin', async () => {
    const tenantId = await newTenant();
    const a = await createActor('TENANT_ADMIN', tenantId);
    const b = await createActor('TENANT_ADMIN', tenantId);

    const [ab, ba] = await Promise.all([
      request(app).put(`/api/users/${b.id}`).set(headersFor(a)).send({ role: 'EVENT_ADMIN' }),
      request(app).put(`/api/users/${a.id}`).set(headersFor(b)).send({ role: 'EVENT_ADMIN' }),
    ]);
    // The loser is refused either by the role gate (it was demoted before
    // its own request authenticated: 403) or by the last-admin rule (409).
    const statuses = [ab.status, ba.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(await prisma.user.count({ where: { tenantId, role: 'TENANT_ADMIN', isActive: true, isArchived: false } })).toBe(1);
  }, 60000);

  it('two demotions that both got past their checks: the tenant lock lets exactly one through', async () => {
    const tenantId = await newTenant();
    const a = await createActor('TENANT_ADMIN', tenantId);
    const b = await createActor('TENANT_ADMIN', tenantId);

    // Called on the service directly, so neither is refused at the HTTP
    // role gate. And each transaction is held right after it counts the
    // other admins until BOTH have counted (capped at 1.5 s), which forces
    // the race: without the tenant lock both count "one other admin" and
    // both demote. With it, the second is blocked at FOR UPDATE, so the
    // first waits out the cap and commits, and the second then counts zero.
    const realCount = userRepository.countOtherActiveWithRole;
    let counted = 0;
    vi.spyOn(userRepository, 'countOtherActiveWithRole').mockImplementation(async (...args) => {
      const n = await realCount(...args);
      counted += 1;
      const deadline = Date.now() + 1500;
      while (counted < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return n;
    });

    const results = await Promise.allSettled([
      userService.update(b.id, 'TENANT_ADMIN', tenantId, a.id, { role: 'EVENT_ADMIN' }),
      userService.update(a.id, 'TENANT_ADMIN', tenantId, b.id, { role: 'EVENT_ADMIN' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409, message: LAST_TENANT_ADMIN_DEMOTE_MESSAGE });
    expect(await prisma.user.count({ where: { tenantId, role: 'TENANT_ADMIN', isActive: true, isArchived: false } })).toBe(1);
  }, 60000);
});

describe('suspend and reactivate by a TENANT_ADMIN', () => {
  it("nobody can suspend themselves (403)", async () => {
    const tenantId = await newTenant();
    const a = await createActor('TENANT_ADMIN', tenantId);
    await createActor('TENANT_ADMIN', tenantId);
    const res = await request(app).post(`/api/users/${a.id}/suspend`).set(headersFor(a));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(SELF_SUSPEND_MESSAGE);
  }, 60000);

  it('suspends a member (revoking their devices), still lists them as SUSPENDED, and reactivates them', async () => {
    const tenantId = await newTenant();
    const admin = await createActor('TENANT_ADMIN', tenantId);
    const member = await createActor('EVENT_ADMIN', tenantId);
    await prisma.deviceToken.create({ data: { userId: member.id, tokenHash: `hash-${member.id}`, expiresAt: new Date(Date.now() + 86400000) } });

    expect((await request(app).post(`/api/users/${member.id}/suspend`).set(headersFor(admin))).status).toBe(200);
    expect((await prisma.deviceToken.findFirst({ where: { userId: member.id } }))?.revokedAt).not.toBeNull();

    const list = await request(app).get('/api/users').set(headersFor(admin));
    const row = list.body.data.find((u: { id: string }) => u.id === member.id);
    expect(row).toMatchObject({ status: 'SUSPENDED', role: 'EVENT_ADMIN', assignments: [] });

    expect((await request(app).post(`/api/users/${member.id}/reactivate`).set(headersFor(admin))).status).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: member.id } }))?.isActive).toBe(true);
  }, 60000);

  it("another tenant's member is a 404", async () => {
    const tenantId = await newTenant();
    const otherTenantId = await newTenant();
    const admin = await createActor('TENANT_ADMIN', tenantId);
    const outsider = await createActor('EVENT_ADMIN', otherTenantId);
    expect((await request(app).post(`/api/users/${outsider.id}/suspend`).set(headersFor(admin))).status).toBe(404);
  }, 60000);
});

describe('PUT /api/users/:id', () => {
  it('with vendors off, changing a role to EVENT_VENDOR is 422; re-sending a vendor their own role is not', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'vendors');
    const tenantId = await newTenant();
    const admin = await createActor('TENANT_ADMIN', tenantId);
    const member = await createActor('EVENT_ADMIN', tenantId);
    const vendor = await createActor('EVENT_VENDOR', tenantId);

    const refused = await request(app).put(`/api/users/${member.id}`).set(headersFor(admin)).send({ role: 'EVENT_VENDOR' });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe(VENDOR_ROLE_UNAVAILABLE_MESSAGE);
    expect((await prisma.user.findUnique({ where: { id: member.id } }))?.role).toBe('EVENT_ADMIN');

    const unchanged = await request(app).put(`/api/users/${vendor.id}`).set(headersFor(admin)).send({ role: 'EVENT_VENDOR' });
    expect(unchanged.status).toBe(200);
  }, 60000);

  it('writes only username and role: tenantId, email and isActive in the body are ignored', async () => {
    const tenantId = await newTenant();
    const otherTenantId = await newTenant();
    const admin = await createActor('TENANT_ADMIN', tenantId);
    const member = await createActor('EVENT_ADMIN', tenantId);

    const res = await request(app)
      .put(`/api/users/${member.id}`)
      .set(headersFor(admin))
      .send({ username: 'Renamed', tenantId: otherTenantId, email: 'stolen@test.invalid', isActive: false });
    expect(res.status).toBe(200);
    const row = await prisma.user.findUnique({ where: { id: member.id } });
    expect(row).toMatchObject({ username: 'Renamed', tenantId, email: member.email, isActive: true });
  }, 60000);

  it('promoting an event admin to tenant admin clears their assignments', async () => {
    const tenantId = await newTenant();
    const admin = await createActor('TENANT_ADMIN', tenantId);
    const member = await createActor('EVENT_ADMIN', tenantId);
    const { event } = await createEventWithDay(tenantId, admin.id);
    await assign(tenantId, member.id, event.id, admin.id);

    expect((await request(app).put(`/api/users/${member.id}`).set(headersFor(admin)).send({ role: 'TENANT_ADMIN' })).status).toBe(200);
    expect(await prisma.eventAssignment.count({ where: { userId: member.id } })).toBe(0);
  }, 60000);
});
