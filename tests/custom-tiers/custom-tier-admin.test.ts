import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import * as paystackClient from '../../src/shared/payments/paystack.client.js';
import { customTierEndingService } from '../../src/modules/custom-tier/custom-tier-ending.service.js';
import { writeTierConfigs, restoreTierConfigs, createCustomTier, onCustomTier, deleteCustomTierFixtures, TRIAL_VALUES } from './custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  CUSTOM TIERS — the super admin's tiers and assigning them, over HTTP
//  (STEERING "Custom tiers"). Retired tiers can't be assigned; an active
//  Paystack subscription blocks an assignment until confirmed cancelled;
//  custom tiers are never offered for purchase; the tenant is emailed 7 days
//  before its custom tier ends.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const tenantIds: string[] = [];
const customTierIds: string[] = [];
let superAdmin: Actor;

const asSuper = () => headersFor(superAdmin);

const newTenant = async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: 'SPARK' } });
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  return { tenantId: tenant.id, email: tenant.email, admin };
};

const assign = (tenantId: string, body: Record<string, unknown>) =>
  request(app).put(`/api/admin/tenants/${tenantId}/custom-tier`).set(asSuper()).send(body);

beforeAll(async () => {
  await writeTierConfigs();
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 60_000);

afterAll(async () => {
  const created = await prisma.customTier.findMany({ where: { name: { startsWith: 'Admin test ' } }, select: { id: true } });
  customTierIds.push(...created.map((t) => t.id));
  await deleteCustomTierFixtures({ tenantIds, customTierIds });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await deleteTenantsDeep(tenantIds);
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
  await restoreTierConfigs();
}, 120_000);

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});
afterEach(() => vi.restoreAllMocks());

describe('the super admin manages custom tiers', () => {
  it('creates one (settings like a standard tier), refuses a name already used, edits and retires it', async () => {
    const name = `Admin test ${randomUUID().slice(0, 8)}`;
    const created = await request(app).post('/api/admin/custom-tiers').set(asSuper()).send({ name, description: 'A group deal', ...TRIAL_VALUES });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name, description: 'A group deal', isActive: true, maxEvents: 2, maxMemoryHubBytesPerEvent: 1000 });
    const id = created.body.data.id as string;

    const again = await request(app).post('/api/admin/custom-tiers').set(asSuper()).send({ name: name.toUpperCase() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CUSTOM_TIER_NAME_TAKEN');

    const bad = await request(app).put(`/api/admin/custom-tiers/${id}`).set(asSuper()).send({ maxEvents: -1 });
    expect(bad.status).toBe(422);

    const edited = await request(app).put(`/api/admin/custom-tiers/${id}`).set(asSuper()).send({ maxEvents: null, smsEnabled: true });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ maxEvents: null, smsEnabled: true });

    const retired = await request(app).put(`/api/admin/custom-tiers/${id}`).set(asSuper()).send({ isActive: false });
    expect(retired.body.data.isActive).toBe(false);

    const list = await request(app).get('/api/admin/custom-tiers').set(asSuper());
    expect(list.status).toBe(200);
    expect(list.body.data.find((t: { id: string }) => t.id === id)).toMatchObject({ isActive: false, tenantCount: 0 });
  });

  it('is hidden from everyone else (the global 404)', async () => {
    const { admin } = await newTenant();
    const res = await request(app).get('/api/admin/custom-tiers').set(headersFor(admin));
    expect(res.status).toBe(404);
    const assignRes = await request(app).put(`/api/admin/tenants/${admin.tenantId}/custom-tier`).set(headersFor(admin)).send({});
    expect(assignRes.status).toBe(404);
  });
});

describe('assigning a custom tier', () => {
  it('moves a tenant onto it with an end date, many tenants share one, and back off', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const a = await newTenant();
    const b = await newTenant();

    const res = await assign(a.tenantId, { customTierId: tier.id, endsAt: '2099-01-31' });
    expect(res.status).toBe(200);
    expect(res.body.data.customTier).toMatchObject({ id: tier.id, name: tier.name, endsAt: '2099-01-31T23:59:59.999Z' });
    expect((await assign(b.tenantId, { customTierId: tier.id })).status).toBe(200);

    const list = await request(app).get('/api/admin/custom-tiers').set(asSuper());
    expect(list.body.data.find((t: { id: string }) => t.id === tier.id).tenantCount).toBe(2);

    const tenants = await request(app).get('/api/tenants').set(asSuper());
    expect(tenants.body.data.find((t: { id: string }) => t.id === a.tenantId).customTier).toMatchObject({ name: tier.name });

    const off = await request(app).delete(`/api/admin/tenants/${a.tenantId}/custom-tier`).set(asSuper());
    expect(off.status).toBe(200);
    const me = await request(app).get('/api/tenants/me').set(headersFor(a.admin));
    expect(me.body.data.customTier).toBeNull();
    expect(me.body.data.planSettings.maxEvents).toBe(1); // Spark
  });

  it('refuses an end date in the past', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const { tenantId } = await newTenant();
    const res = await assign(tenantId, { customTierId: tier.id, endsAt: '2020-01-01' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CUSTOM_TIER_END_DATE_INVALID');
  });

  it('a retired tier cannot be assigned; a tenant already on it keeps it', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const keeper = await newTenant();
    expect((await assign(keeper.tenantId, { customTierId: tier.id })).status).toBe(200);
    await request(app).put(`/api/admin/custom-tiers/${tier.id}`).set(asSuper()).send({ isActive: false });

    const other = await newTenant();
    const res = await assign(other.tenantId, { customTierId: tier.id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CUSTOM_TIER_RETIRED');
    expect((await prisma.tenant.findUnique({ where: { id: other.tenantId } }))!.customTierId).toBeNull();

    const me = await request(app).get('/api/tenants/me').set(headersFor(keeper.admin));
    expect(me.body.data.customTier).toMatchObject({ id: tier.id });
    expect(me.body.data.planSettings.maxEvents).toBe(2);
  });

  it('an active Paystack subscription blocks it until the super admin confirms it is cancelled', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const { tenantId } = await newTenant();
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionTier: 'CELEBRATE',
        subscriptionPeriod: 'MONTHLY',
        subscriptionCurrentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
        paystackSubscriptionCode: `SUB_${randomUUID()}`,
        paystackSubscriptionEmailToken: 'token',
      },
    });

    const refused = await assign(tenantId, { customTierId: tier.id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CUSTOM_TIER_ACTIVE_SUBSCRIPTION');
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))!.customTierId).toBeNull();

    const confirmed = await assign(tenantId, { customTierId: tier.id, confirmSubscriptionCancelled: true });
    expect(confirmed.status).toBe(200);
    const after = (await prisma.tenant.findUnique({ where: { id: tenantId } }))!;
    expect(after).toMatchObject({ customTierId: tier.id, subscriptionTier: 'SPARK', paystackSubscriptionCode: null, subscriptionPeriod: null });
  });

  it('a subscription already cancelled at period end does not block it', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const { tenantId } = await newTenant();
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { subscriptionTier: 'CELEBRATE', paystackSubscriptionCode: `SUB_${randomUUID()}`, subscriptionCancelAtPeriodEnd: true, subscriptionCurrentPeriodEnd: new Date(Date.now() + DAY_MS) },
    });
    expect((await assign(tenantId, { customTierId: tier.id })).status).toBe(200);
  });

  it('new sign-ups stay on Spark: a tenant created as usual has no custom tier', async () => {
    const { admin } = await newTenant();
    const me = await request(app).get('/api/tenants/me').set(headersFor(admin));
    expect(me.body.data.customTier).toBeNull();
  });
});

describe('custom tiers are never offered for purchase', () => {
  it('the plans and prices list only the standard tiers', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const { admin } = await newTenant();
    const res = await request(app).get('/api/subscriptions/plans').set(headersFor(admin));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.prices).sort()).toEqual(['CELEBRATE', 'ELEVATE', 'SPARK']);
    expect(JSON.stringify(res.body)).not.toContain(tier.name);
    expect(JSON.stringify(res.body)).not.toContain(tier.id);
  });

  it('subscribing to a custom tier (by id or name) is refused before anything is saved or Paystack is called', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const { tenantId, admin } = await newTenant();
    const init = vi.spyOn(paystackClient, 'initializeTransaction');
    for (const body of [{ tier: tier.id, period: 'MONTHLY' }, { tier: tier.name, period: 'MONTHLY' }, { tier: 'SPARK', period: 'MONTHLY' }]) {
      const res = await request(app).post('/api/subscriptions/subscribe').set(headersFor(admin)).send(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SUBSCRIPTION_PLAN_UNKNOWN');
    }
    const change = await request(app).put('/api/subscriptions/change-tier').set(headersFor(admin)).send({ tier: tier.id, period: 'MONTHLY' });
    expect(change.status).toBe(422);
    expect(change.body.code).toBe('SUBSCRIPTION_PLAN_UNKNOWN');
    expect(init).not.toHaveBeenCalled();
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))!.subscriptionPendingReference).toBeNull();
  });
});

describe('the tenant is emailed 7 days before its custom tier ends', () => {
  it('once per assignment and end date, at the organisation address; not when further off', async () => {
    const tier = await createCustomTier();
    customTierIds.push(tier.id);
    const soon = await newTenant();
    const later = await newTenant();
    await onCustomTier(soon.tenantId, tier.id, new Date(Date.now() + 3 * DAY_MS));
    await onCustomTier(later.tenantId, tier.id, new Date(Date.now() + 10 * DAY_MS));

    const first = await customTierEndingService.sweep(new Date(), { tenantIds: [soon.tenantId, later.tenantId] });
    expect(first).toEqual({ sent: 1, failed: 0 });
    const mail = sentEmails().filter((m) => m.to === soon.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain(`Your ${tier.name} plan ends on`);
    expect(mail[0]!.text).toContain('Spark');
    expect(sentEmails().some((m) => m.to === later.email)).toBe(false);

    const second = await customTierEndingService.sweep(new Date(), { tenantIds: [soon.tenantId, later.tenantId] });
    expect(second).toEqual({ sent: 0, failed: 0 });

    // A new end date is a new notice.
    await assign(soon.tenantId, { customTierId: tier.id, endsAt: new Date(Date.now() + 5 * DAY_MS).toISOString() });
    expect((await customTierEndingService.sweep(new Date(), { tenantIds: [soon.tenantId] })).sent).toBe(1);
  });
});
