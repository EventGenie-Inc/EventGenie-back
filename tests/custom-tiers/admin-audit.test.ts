import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, createEventWithDay, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { writeTierConfigs, restoreTierConfigs, createCustomTier, deleteCustomTierFixtures } from './custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  THE SUPER ADMIN AUDIT LOG (STEERING "Super admin audit log")
//
//  Every super admin write that changes a tenant's account (or the
//  platform's tiers) leaves an entry: who, which tenant, what, when, and the
//  details. The super admin reads them per tenant. Other users' writes, and
//  refused writes, leave none.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
const customTierIds: string[] = [];
let superAdmin: Actor;
let tenantId: string;
let tenantAdmin: Actor;

const asSuper = () => headersFor(superAdmin);

// Entries are written in the request (the services') or right after the
// response (the catch-all), so a read waits briefly for them.
const entriesFor = async (where: { tenantId?: string | null; action?: string }, atLeast = 1) => {
  let rows: Awaited<ReturnType<typeof prisma.adminAuditEntry.findMany>> = [];
  await vi.waitFor(async () => {
    rows = await prisma.adminAuditEntry.findMany({ where: { actorUserId: superAdmin.id, ...where }, orderBy: { createdAt: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(atLeast);
  }, { timeout: 5000, interval: 50 });
  return rows;
};

beforeAll(async () => {
  await writeTierConfigs();
  superAdmin = await createActor('SUPER_ADMIN', null);
  const tenant = await createTenant();
  tenantId = tenant.id;
  tenantIds.push(tenantId);
  tenantAdmin = await createActor('TENANT_ADMIN', tenantId);
}, 60_000);

afterAll(async () => {
  await deleteCustomTierFixtures({ tenantIds, customTierIds });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: { in: [superAdmin.id, tenantAdmin.id] } } });
  await prisma.eventMediaPurge.deleteMany({ where: { event: { tenantId: { in: tenantIds } } } });
  await deleteTenantsDeep(tenantIds);
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
  await restoreTierConfigs();
}, 120_000);

beforeEach(() => installFirebaseMock());

describe('every super admin write leaves an audit entry', () => {
  it('custom tiers: created and edited (platform-wide), assigned and taken off (the tenant)', async () => {
    const created = await request(app).post('/api/admin/custom-tiers').set(asSuper()).send({ name: `Audit ${randomUUID().slice(0, 8)}`, maxEvents: 3 });
    expect(created.status).toBe(201);
    customTierIds.push(created.body.data.id);
    await request(app).put(`/api/admin/custom-tiers/${created.body.data.id}`).set(asSuper()).send({ maxEvents: 4 });
    await request(app).put(`/api/admin/tenants/${tenantId}/custom-tier`).set(asSuper()).send({ customTierId: created.body.data.id, endsAt: '2099-01-01' });
    await request(app).delete(`/api/admin/tenants/${tenantId}/custom-tier`).set(asSuper());

    const [made] = await entriesFor({ action: 'CUSTOM_TIER_CREATED', tenantId: null });
    expect(made!.details).toMatchObject({ customTierId: created.body.data.id });
    const [edited] = await entriesFor({ action: 'CUSTOM_TIER_UPDATED', tenantId: null });
    expect(edited!.details).toMatchObject({ changed: ['maxEvents'], before: { maxEvents: 3 }, after: { maxEvents: 4 } });
    const [assigned] = await entriesFor({ action: 'CUSTOM_TIER_ASSIGNED', tenantId });
    expect(assigned).toMatchObject({ actorEmail: superAdmin.email, details: { customTierId: created.body.data.id, endsAt: '2099-01-01T23:59:59.999Z' } });
    await entriesFor({ action: 'CUSTOM_TIER_REMOVED', tenantId });
  });

  it('suspending and reactivating a tenant', async () => {
    expect((await request(app).post(`/api/tenants/${tenantId}/suspend`).set(asSuper())).status).toBe(200);
    expect((await request(app).post(`/api/tenants/${tenantId}/reactivate`).set(asSuper())).status).toBe(200);
    const [suspended] = await entriesFor({ action: 'TENANT_SUSPENDED', tenantId });
    expect((suspended!.details as { usersSuspended: string[] }).usersSuspended).toContain(tenantAdmin.id);
    await entriesFor({ action: 'TENANT_REACTIVATED', tenantId });
  });

  it('restoring an archived event, and purging an archived event\'s media', async () => {
    const { event } = await createEventWithDay(tenantId, tenantAdmin.id);
    await prisma.event.update({ where: { id: event.id }, data: { isArchived: true, archivedAt: new Date() } });
    expect((await request(app).post(`/api/events/${event.id}/reactivate`).set(asSuper())).status).toBe(200);
    const [restored] = await entriesFor({ action: 'EVENT_RESTORED', tenantId });
    expect(restored!.details).toMatchObject({ eventId: event.id });

    const { event: other } = await createEventWithDay(tenantId, tenantAdmin.id);
    await prisma.event.update({ where: { id: other.id }, data: { isArchived: true, archivedAt: new Date() } });
    const purge = await request(app).post(`/api/admin/events/${other.id}/media-purge`).set(asSuper());
    expect(purge.status).toBe(200);
    const [purged] = await entriesFor({ action: 'EVENT_MEDIA_PURGED', tenantId });
    expect(purged!.details).toMatchObject({ eventId: other.id });
  });

  it('a standard tier\'s settings and availability (platform-wide)', async () => {
    expect((await request(app).put('/api/subscription-tiers/CELEBRATE').set(asSuper()).send({ maxEvents: 6 })).status).toBe(200);
    expect((await request(app).put('/api/subscription-tiers/CELEBRATE/availability').set(asSuper()).send({ isAvailable: false })).status).toBe(200);
    const [updated] = await entriesFor({ action: 'TIER_CONFIG_UPDATED', tenantId: null });
    expect(updated!.details).toMatchObject({ tier: 'CELEBRATE', before: { maxEvents: 5 }, after: { maxEvents: 6 } });
    await entriesFor({ action: 'TIER_AVAILABILITY_CHANGED', tenantId: null });
  });

  it("a custom tier request's status and note", async () => {
    const req = await prisma.customTierRequest.create({
      data: { tenantId, requestedByUserId: tenantAdmin.id, needs: 'More', contactName: 'A', contactEmail: 'a@test.invalid' },
    });
    expect((await request(app).patch(`/api/admin/custom-tier-requests/${req.id}`).set(asSuper()).send({ status: 'DECLINED' })).status).toBe(200);
    const [entry] = await entriesFor({ action: 'CUSTOM_TIER_REQUEST_UPDATED', tenantId });
    expect(entry!.details).toMatchObject({ requestId: req.id, status: { before: 'NEW', after: 'DECLINED' } });
  });

  it('any other super admin write, through an organiser route, against the tenant it touched', async () => {
    const { event } = await createEventWithDay(tenantId, tenantAdmin.id);
    const res = await request(app).put(`/api/events/${event.id}`).set(asSuper()).send({ name: 'Renamed by support', hostName: 'Support' });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: 'API_WRITE', tenantId });
    expect(entry!.details).toMatchObject({ method: 'PUT', path: `/api/events/${event.id}`, status: 200, fields: ['name', 'hostName'] });
    // Names of the fields only, never their values.
    expect(JSON.stringify(entry!.details)).not.toContain('Renamed by support');
  });

  it("a tenant's own writes and a super admin's refused write leave none", async () => {
    const before = await prisma.adminAuditEntry.count();
    const { event } = await createEventWithDay(tenantId, tenantAdmin.id);
    expect((await request(app).put(`/api/events/${event.id}`).set(headersFor(tenantAdmin)).send({ name: 'Mine', hostName: 'Me' })).status).toBe(200);
    const tier = await createCustomTier({ isActive: false });
    customTierIds.push(tier.id);
    expect((await request(app).put(`/api/admin/tenants/${tenantId}/custom-tier`).set(asSuper()).send({ customTierId: tier.id })).status).toBe(422);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.adminAuditEntry.count()).toBe(before);
  });
});

describe('the super admin views the log per tenant', () => {
  it('newest first, with who and what; hidden from everyone else', async () => {
    const res = await request(app).get(`/api/admin/tenants/${tenantId}/audit-log`).set(asSuper());
    expect(res.status).toBe(200);
    const rows = res.body.data as { action: string; tenantId: string; actorEmail: string; createdAt: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.every((r) => r.tenantId === tenantId && r.actorEmail === superAdmin.email)).toBe(true);
    const times = rows.map((r) => new Date(r.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['CUSTOM_TIER_ASSIGNED', 'TENANT_SUSPENDED', 'EVENT_RESTORED', 'API_WRITE']));

    const limited = await request(app).get(`/api/admin/tenants/${tenantId}/audit-log?limit=2`).set(asSuper());
    expect(limited.body.data).toHaveLength(2);

    expect((await request(app).get(`/api/admin/tenants/${tenantId}/audit-log`).set(headersFor(tenantAdmin))).status).toBe(404);
  });
});

describe('the log pages with a stable cursor: createdAt, then id', () => {
  // Five entries written in the same millisecond (a grant to many tenants,
  // a bulk change): paging two at a time by createdAt alone used to skip the
  // ones sharing the last entry's timestamp.
  it('never skips or repeats entries that share a timestamp, per tenant and across the platform', async () => {
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const at = new Date('2001-02-03T04:05:06.789Z');
    const written = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => prisma.adminAuditEntry.create({
        data: { actorUserId: superAdmin.id, actorEmail: superAdmin.email, tenantId: tenant.id, action: 'API_WRITE', details: { n }, createdAt: at },
      }))
    );
    const expected = written.map((e) => e.id).sort().reverse();

    const pageThrough = async (path: string, first: string) => {
      const seen: string[] = [];
      let query = first;
      for (let i = 0; i < 10; i += 1) {
        const res = await request(app).get(`${path}?limit=2${query}`).set(asSuper());
        expect(res.status).toBe(200);
        const rows = (res.body.data as { id: string; createdAt: string }[]).filter((r) => r.createdAt === at.toISOString());
        seen.push(...rows.map((r) => r.id));
        const last = res.body.data.at(-1) as { id: string; createdAt: string } | undefined;
        if (!last || new Date(last.createdAt) < at) break;
        query = `&before=${encodeURIComponent(last.createdAt)}&beforeId=${last.id}`;
      }
      return seen;
    };

    // The tenant's log: from the newest.
    expect(await pageThrough(`/api/admin/tenants/${tenant.id}/audit-log`, '')).toEqual(expected);
    // The whole log: from just after the shared timestamp.
    expect(await pageThrough('/api/admin/audit-log', `&before=${encodeURIComponent(new Date(at.getTime() + 1).toISOString())}`)).toEqual(expected);
  });

  it('beforeId needs before, and is an entry id', async () => {
    expect((await request(app).get(`/api/admin/tenants/${tenantId}/audit-log?beforeId=abc`).set(asSuper())).status).toBe(400);
    expect((await request(app).get(`/api/admin/audit-log?before=2001-01-01T00:00:00.000Z&beforeId=`).set(asSuper())).status).toBe(400);
  });
});
