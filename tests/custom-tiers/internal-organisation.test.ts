import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  THE INTERNAL E-VELOPE ORGANISATION (STEERING "Custom tiers")
//
//  It holds event templates, not a customer: never in the super admin's
//  tenant list (reached through /api/admin/event-templates/organisation),
//  and never given anything a tenant could see: no users (who would see its
//  templates), no vendor spaces (vendor discovery is cross-tenant).
// ─────────────────────────────────────────

let superAdmin: Actor;
let internalTenantId: string;
const tenantIds: string[] = [];

beforeAll(async () => {
  installFirebaseMock();
  superAdmin = await createActor('SUPER_ADMIN', null);
  internalTenantId = (await prisma.tenant.findFirstOrThrow({ where: { isInternal: true } })).id;
  const tenant = await createTenant(`Internal Org Neighbour ${randomUUID().slice(0, 8)}`);
  tenantIds.push(tenant.id);
}, 60_000);

afterAll(async () => {
  await prisma.vendorSpace.deleteMany({ where: { tenantId: internalTenantId, createdBy: superAdmin.id } });
  await prisma.user.deleteMany({ where: { tenantId: internalTenantId, email: { endsWith: '@internal-org.test.invalid' } } });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await deleteTenantsDeep(tenantIds);
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120_000);

beforeEach(() => installFirebaseMock());

describe('the internal organisation', () => {
  it("is not in the super admin's tenant list; every other tenant is", async () => {
    const res = await request(app).get('/api/tenants').set(headersFor(superAdmin));
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string; isInternal: boolean }[]).map((t) => t.id);
    expect(ids).toContain(tenantIds[0]);
    expect(ids).not.toContain(internalTenantId);
    expect((res.body.data as { isInternal: boolean }[]).every((t) => t.isInternal === false)).toBe(true);

    // Still reachable where templates are managed.
    const org = await request(app).get('/api/admin/event-templates/organisation').set(headersFor(superAdmin));
    expect(org.body.data.id).toBe(internalTenantId);
  });

  it("can't be given a user", async () => {
    const res = await request(app).post('/api/users').set(headersFor(superAdmin)).send({
      firebaseUid: `fb-${randomUUID()}`,
      email: `${randomUUID().slice(0, 8)}@internal-org.test.invalid`,
      username: 'Template viewer',
      role: 'EVENT_ADMIN',
      tenantId: internalTenantId,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TENANT_INTERNAL');
    expect(await prisma.user.count({ where: { tenantId: internalTenantId, email: { endsWith: '@internal-org.test.invalid' } } })).toBe(0);
  });

  it("can't be given a vendor space, which every tenant's discovery would show", async () => {
    const res = await request(app).post('/api/vendors').set(headersFor(superAdmin)).send({
      name: 'e-velope catering', email: 'catering@test.invalid', latitude: -33.9, longitude: 18.4, tenantId: internalTenantId,
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TENANT_INTERNAL');
    expect(await prisma.vendorSpace.count({ where: { tenantId: internalTenantId } })).toBe(0);
  });
});
