import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { HttpError } from '../../src/shared/errors/http-error.js';
import {
  resolveEventPlan,
  resolvePlanIdentity,
  resolveTenantPlan,
  resolveStandardPlan,
  plansWithCapability,
} from '../../src/modules/subscription-tier-config/effective-plan.util.js';
import { assertEventCreatable, assertWithinEventLimit } from '../../src/modules/subscription-tier-config/event-tier-enforcement.util.js';
import { resolveGuestLimit, assertGuestsCreatable } from '../../src/modules/subscription-tier-config/guest-tier-enforcement.util.js';
import { assertGuestExportEnabled } from '../../src/modules/subscription-tier-config/guest-export-tier-enforcement.util.js';
import { assertSmsSendable } from '../../src/modules/subscription-tier-config/sms-tier-enforcement.util.js';
import { assertMemoryHubAccessible, getMemoryHubQuotaBytes } from '../../src/modules/memory-hub/memory-hub-tier-enforcement.util.js';
import { resolveDocumentLimits } from '../../src/modules/guest-document/guest-document-allowance.util.js';
import { assertTenantReadyToSellTickets } from '../../src/modules/payment-account/payment-account-readiness.util.js';
import { assertVendorMarketplaceAccessible, resolveVendorSpaceLimit } from '../../src/modules/vendor/vendor-tier-enforcement.util.js';
import { isPriorityPlan } from '../../src/modules/vendor/vendor-priority.util.js';
import { TIER_VALUES, TRIAL_VALUES, writeTierConfigs, restoreTierConfigs, createCustomTier, onCustomTier, deleteCustomTierFixtures } from './custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  CUSTOM TIERS — ONE RESOLUTION (STEERING "Custom tiers")
//
//  A tenant on a custom tier gets the custom tier's settings at every tier
//  check (effective-plan.util.ts), is back on Spark after its end date, and
//  compares with an Event Pass per setting (the more generous wins). A
//  tenant on a standard tier is unaffected: same settings, same pass rule,
//  same wording.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const tenantIds: string[] = [];
const customTierIds: string[] = [];
let customTenantId: string;
let customAdmin: Actor;
let trialId: string;
let trialName: string;

const reload = async (id: string) => (await prisma.tenant.findUnique({ where: { id } }))!;

const eventOf = async (tenantId: string, userId: string, opts: { pass?: 'SMALL' | 'STANDARD' | 'LARGE' } = {}) => {
  const event = await prisma.event.create({
    data: { tenantId, createdByUserId: userId, name: `Event ${randomUUID()}`, status: 'PUBLISHED', createdBy: userId, updatedBy: userId },
  });
  if (opts.pass) await prisma.eventPass.create({ data: { eventId: event.id, tenantId, passTier: opts.pass } });
  return prisma.event.findUniqueOrThrow({ where: { id: event.id }, include: { eventPass: true, eventDays: true } });
};

const refusal = async (fn: () => Promise<unknown>): Promise<HttpError> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
};

const standardTenant = async (tier: 'SPARK' | 'CELEBRATE' | 'ELEVATE') => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: tier } });
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  return { tenantId: tenant.id, admin };
};

beforeAll(async () => {
  await writeTierConfigs();
  const trial = await createCustomTier();
  trialId = trial.id;
  trialName = trial.name;
  customTierIds.push(trialId);
  ({ tenantId: customTenantId, admin: customAdmin } = await standardTenant('SPARK'));
  await onCustomTier(customTenantId, trialId);
}, 60_000);

afterAll(async () => {
  await deleteCustomTierFixtures({ tenantIds, customTierIds });
  await deleteTenantsDeep(tenantIds);
  await restoreTierConfigs();
}, 120_000);

beforeEach(() => installFirebaseMock());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a tenant on a custom tier gets its limits everywhere', () => {
  it('resolves to the custom tier, by name, over the billing tier (Spark)', async () => {
    const plan = await resolveTenantPlan(await reload(customTenantId));
    expect(plan.name).toBe(trialName);
    expect(plan.tier).toBeNull();
    expect(plan.customTier).toMatchObject({ id: trialId, name: trialName, endsAt: null });
    expect(plan.values).toMatchObject(TRIAL_VALUES);
  });

  it('GET /api/tenants/me: planSettings are the custom tier\'s, with its name; subscriptionTier stays the billing tier', async () => {
    const res = await request(app).get('/api/tenants/me').set(headersFor(customAdmin));
    expect(res.status).toBe(200);
    expect(res.body.data.subscriptionTier).toBe('SPARK');
    expect(res.body.data.customTier).toMatchObject({ id: trialId, name: trialName, endsAt: null });
    expect(res.body.data.planSettings).toMatchObject({
      maxEvents: 2,
      maxGuestsPerEvent: 400,
      memoryHubEnabled: true,
      guestExportEnabled: true,
      publicEventsEnabled: true,
      paidTicketingEnabled: false,
      customRsvpFieldsEnabled: true,
      smsEnabled: false,
      maxMemoryHubBytesPerEvent: 1000,
      maxDocumentBytesPerEvent: 2000,
      maxDocumentBytesPerFile: 100,
    });
    expect(res.body.data.vendorSpaceLimit.limit).toBe(1);
  });

  it('GET /api/subscriptions shows the custom tier (name, end date), with the billing tier beside it', async () => {
    const res = await request(app).get('/api/subscriptions').set(headersFor(customAdmin));
    expect(res.status).toBe(200);
    expect(res.body.data.customTier).toMatchObject({ id: trialId, name: trialName, endsAt: null });
    expect(res.body.data.tier).toBe('SPARK');
  });

  it('creation gates: public and additional fields allowed (Spark has neither); paid refused, naming the plan, never selling one', async () => {
    const tenant = await reload(customTenantId);
    await expect(assertEventCreatable(tenant.id, { visibility: 'PUBLIC', hasCustomRsvpFields: true })).resolves.toBeUndefined();
    const paid = await refusal(() => assertEventCreatable(tenant.id, { ticketing: 'PAID' }));
    expect(paid.statusCode).toBe(403);
    expect(paid.message).toBe(`Paid ticketing isn't available on your ${trialName} plan. Contact us at admin@e-velope.co.za if you need it.`);
    const payout = await refusal(() => assertTenantReadyToSellTickets(tenant.id));
    expect(payout.statusCode).toBe(403);
    expect(payout.message).not.toMatch(/upgrade/i);
  });

  it("the active-event limit is the custom tier's (2, where Spark's is 1)", async () => {
    await eventOf(customTenantId, customAdmin.id);
    await expect(assertWithinEventLimit(customTenantId)).resolves.toBeUndefined();
    await eventOf(customTenantId, customAdmin.id);
    const full = await refusal(() => assertWithinEventLimit(customTenantId));
    expect(full.statusCode).toBe(403);
    expect(full.code).toBe('EVENT_LIMIT_REACHED');
    expect(full.message).toContain(`on your ${trialName} plan`);
    await prisma.event.updateMany({ where: { tenantId: customTenantId }, data: { isArchived: true } });
  });

  it('event-scoped: guests, export, Memory Hub, documents and SMS follow the custom tier', async () => {
    const event = await eventOf(customTenantId, customAdmin.id);
    const guests = await resolveGuestLimit(event);
    expect(guests).toMatchObject({ limit: 400, tenantTier: null, planName: trialName });
    await expect(assertGuestsCreatable(event, 3)).resolves.toBeUndefined(); // Spark: 2
    await expect(assertGuestExportEnabled(event)).resolves.toBeUndefined();
    await expect(assertMemoryHubAccessible(event)).resolves.toBeUndefined();
    expect(await getMemoryHubQuotaBytes(event)).toBe(1000);
    expect(await resolveDocumentLimits(event)).toEqual({ maxBytesPerEvent: 2000, maxBytesPerDocument: 100 });
    const sms = await refusal(() => assertSmsSendable(event, 1));
    expect(sms.statusCode).toBe(403);
    expect(sms.message).toContain(`on your ${trialName} plan`);
  });

  it('vendors: the marketplace, the space limit and priority placement follow the custom tier', async () => {
    const tenant = await reload(customTenantId);
    await expect(assertVendorMarketplaceAccessible(tenant.id)).resolves.toBeUndefined();
    expect((await resolveVendorSpaceLimit(tenant)).limit).toBe(1);
    const plans = await plansWithCapability('vendorPriorityPlacement');
    expect(isPriorityPlan(resolvePlanIdentity(tenant), plans)).toBe(true);
  });
});

describe('after the end date the tenant is back on Spark', () => {
  it('worked out when read: before the date the custom tier, after it Spark', async () => {
    const { tenantId, admin } = await standardTenant('SPARK');
    const endsAt = new Date(Date.now() + 2 * DAY_MS);
    await onCustomTier(tenantId, trialId, endsAt);
    const tenant = await reload(tenantId);

    expect(resolvePlanIdentity(tenant, new Date(endsAt.getTime() - 1))).toEqual({ kind: 'CUSTOM', customTierId: trialId, endsAt });
    expect(resolvePlanIdentity(tenant, endsAt)).toEqual({ kind: 'STANDARD', tier: 'SPARK' });
    expect((await resolveTenantPlan(tenant, new Date(endsAt.getTime() + 1))).values).toEqual((await resolveStandardPlan('SPARK')).values);

    // The date passes: every check is Spark's, and /me says so.
    await prisma.tenant.update({ where: { id: tenantId }, data: { customTierEndsAt: new Date(Date.now() - 1000) } });
    const refused = await refusal(() => assertEventCreatable(tenantId, { visibility: 'PUBLIC' }));
    expect(refused.message).toBe('The Spark plan only supports private events. Upgrade your plan to make this event public.');
    const me = await request(app).get('/api/tenants/me').set(headersFor(admin));
    expect(me.body.data.customTier).toBeNull();
    expect(me.body.data.planSettings).toMatchObject({ maxEvents: 1, maxGuestsPerEvent: 2, publicEventsEnabled: false, memoryHubEnabled: false });
  });
});

describe('a custom tier and an Event Pass: per setting, the more generous wins', () => {
  it("the trial's own guest limit (400) beats a Small pass's 50", async () => {
    const event = await eventOf(customTenantId, customAdmin.id, { pass: 'SMALL' });
    expect((await resolveGuestLimit(event)).limit).toBe(400);
  });

  it("a Large pass's unlimited Memory Hub (Elevate) beats the trial's 1000 bytes; the trial keeps its own priority placement", async () => {
    const event = await eventOf(customTenantId, customAdmin.id, { pass: 'LARGE' });
    expect(await getMemoryHubQuotaBytes(event)).toBeNull();
    const plan = await resolveEventPlan(await reload(customTenantId), event);
    expect(plan.values.vendorPriorityPlacement).toBe(true); // Elevate's is off; the trial's is on
    expect(plan.name).toBe(trialName);
  });

  it("a pass's SMS (Celebrate) is added to a trial without it; paid ticketing likewise", async () => {
    const event = await eventOf(customTenantId, customAdmin.id, { pass: 'STANDARD' });
    const plan = await resolveEventPlan(await reload(customTenantId), event);
    expect(plan.values.smsEnabled).toBe(true);
    expect(plan.values.paidTicketingEnabled).toBe(true);
    expect(plan.values.maxMemoryHubBytesPerEvent).toBe(TIER_VALUES.CELEBRATE.maxMemoryHubBytesPerEvent);
  });
});

describe('a tenant on a standard tier is unaffected', () => {
  it("Spark: Spark's settings and wording, as before", async () => {
    const { tenantId } = await standardTenant('SPARK');
    const plan = await resolveTenantPlan(await reload(tenantId));
    expect(plan).toMatchObject({ name: 'SPARK', tier: 'SPARK', customTier: null });
    expect(plan.values).toMatchObject({ maxEvents: 1, maxGuestsPerEvent: 2, publicEventsEnabled: false, smsEnabled: false });
    const refused = await refusal(() => assertEventCreatable(tenantId, { hasCustomRsvpFields: true }));
    expect(refused.message).toBe('The Spark plan does not support additional fields. Upgrade your plan to add them.');
  });

  it("Celebrate with a Large pass: Elevate's settings whole (the pass rule by rank), not merged", async () => {
    const { tenantId, admin } = await standardTenant('CELEBRATE');
    const event = await eventOf(tenantId, admin.id, { pass: 'LARGE' });
    const plan = await resolveEventPlan(await reload(tenantId), event);
    expect(plan.name).toBe('ELEVATE');
    expect(plan.values.vendorPriorityPlacement).toBe(false); // Elevate's, though Celebrate's is on
  });

  it('Celebrate with a Small pass: its own plan (the pass ranks no higher)', async () => {
    const { tenantId, admin } = await standardTenant('CELEBRATE');
    const event = await eventOf(tenantId, admin.id, { pass: 'SMALL' });
    const plan = await resolveEventPlan(await reload(tenantId), event);
    expect(plan.name).toBe('CELEBRATE');
    expect(plan.values.vendorPriorityPlacement).toBe(true);
    expect((await resolveGuestLimit(event)).limit).toBe(300);
  });

  it('GET /api/tenants/me on Celebrate: customTier null, Celebrate\'s settings', async () => {
    const { admin } = await standardTenant('CELEBRATE');
    const res = await request(app).get('/api/tenants/me').set(headersFor(admin));
    expect(res.body.data.customTier).toBeNull();
    expect(res.body.data.subscriptionTier).toBe('CELEBRATE');
    expect(res.body.data.planSettings).toMatchObject({ maxEvents: 5, maxGuestsPerEvent: 300, smsEnabled: true, memoryHubEnabled: true });
  });
});
