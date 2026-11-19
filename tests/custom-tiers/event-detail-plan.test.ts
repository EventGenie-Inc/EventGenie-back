import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { type EventPassTier, type SubscriptionTier } from '@prisma/client';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, createEventWithDay, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { EVENT_PASS_GUEST_CAP, EVENT_PASS_GRANTED_TIER } from '../../src/modules/event-pass/event-pass-plans.config.js';
import { writeTierConfigs, restoreTierConfigs, createCustomTier, onCustomTier, deleteCustomTierFixtures, TIER_VALUES, TRIAL_VALUES } from './custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  THE EVENT'S PLAN ON GET /api/events/:id (STEERING "Custom tiers")
//
//  The settings that actually apply to the event once the custom tier,
//  Event Pass and grant rules have run, so the frontend never works out what
//  a granted event includes.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
const customTierIds: string[] = [];

const tenantOn = async (tier: SubscriptionTier) => {
  const tenant = await createTenant(`Plan View ${randomUUID().slice(0, 8)}`);
  tenantIds.push(tenant.id);
  await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: tier } });
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  return { tenantId: tenant.id, admin };
};

const eventOf = async (
  t: { tenantId: string; admin: Actor },
  opts: { grantedTier?: SubscriptionTier; grantedCustomTierId?: string; pass?: EventPassTier } = {}
) => {
  const { event } = await createEventWithDay(t.tenantId, t.admin.id);
  if (opts.grantedTier || opts.grantedCustomTierId) {
    await prisma.event.update({ where: { id: event.id }, data: { grantedTier: opts.grantedTier ?? null, grantedCustomTierId: opts.grantedCustomTierId ?? null } });
  }
  if (opts.pass) await prisma.eventPass.create({ data: { eventId: event.id, tenantId: t.tenantId, passTier: opts.pass } });
  const res = await request(app).get(`/api/events/${event.id}`).set(headersFor(t.admin));
  expect(res.status).toBe(200);
  return res.body.data as { plan: Record<string, unknown> & { settings: Record<string, unknown> }; guestLimit: { limit: number | null } };
};

beforeAll(async () => {
  await writeTierConfigs();
}, 60_000);

afterAll(async () => {
  await deleteCustomTierFixtures({ tenantIds, customTierIds });
  await deleteTenantsDeep(tenantIds);
  await restoreTierConfigs();
}, 120_000);

beforeEach(() => installFirebaseMock());

describe("GET /api/events/:id carries the event's resolved plan", () => {
  it('a plain event: the tenant plan\'s settings, without the tenant-wide event limit', async () => {
    const data = await eventOf(await tenantOn('SPARK'));
    expect(data.plan).toMatchObject({
      name: 'SPARK', tenantTier: 'SPARK', customTier: null, grantedTier: null, grantedCustomTier: null, passTier: null, passActive: false,
      smsFrom: 'MONTHLY_ALLOWANCE',
    });
    expect(data.plan.settings).toMatchObject({ maxGuestsPerEvent: TIER_VALUES.SPARK.maxGuestsPerEvent, memoryHubEnabled: false, customRsvpFieldsEnabled: false });
    expect(data.plan.settings).not.toHaveProperty('maxEvents');
  });

  it('a granted event on Spark: the grant\'s Celebrate settings, named as granted', async () => {
    const data = await eventOf(await tenantOn('SPARK'), { grantedTier: 'CELEBRATE' });
    expect(data.plan).toMatchObject({ name: 'SPARK', tenantTier: 'SPARK', grantedTier: 'CELEBRATE', grantedCustomTier: null });
    expect(data.plan.settings).toMatchObject({
      maxGuestsPerEvent: TIER_VALUES.CELEBRATE.maxGuestsPerEvent,
      memoryHubEnabled: true,
      guestExportEnabled: true,
      customRsvpFieldsEnabled: true,
      maxMemoryHubBytesPerEvent: TIER_VALUES.CELEBRATE.maxMemoryHubBytesPerEvent,
    });
    expect(data.guestLimit.limit).toBe(TIER_VALUES.CELEBRATE.maxGuestsPerEvent);
  });

  it('a custom tier granted to a tenant on another custom tier: per setting, the more generous', async () => {
    const own = await createCustomTier({ maxGuestsPerEvent: 50, memoryHubEnabled: false, guestExportEnabled: true });
    const granted = await createCustomTier({ maxGuestsPerEvent: 20, memoryHubEnabled: true, guestExportEnabled: false });
    customTierIds.push(own.id, granted.id);
    const t = await tenantOn('SPARK');
    await onCustomTier(t.tenantId, own.id);
    const data = await eventOf(t, { grantedCustomTierId: granted.id });
    expect(data.plan).toMatchObject({
      name: own.name, tenantTier: null, customTier: { id: own.id, name: own.name }, grantedTier: null, grantedCustomTier: { id: granted.id, name: granted.name },
    });
    expect(data.plan.settings).toMatchObject({ maxGuestsPerEvent: 50, memoryHubEnabled: true, guestExportEnabled: true, maxMemoryHubBytesPerEvent: TRIAL_VALUES.maxMemoryHubBytesPerEvent });
  });

  it("a standard tier with an Event Pass: the pass's tier, the pass's guest number, SMS from the bundle", async () => {
    const data = await eventOf(await tenantOn('SPARK'), { pass: 'LARGE' });
    expect(data.plan).toMatchObject({ name: EVENT_PASS_GRANTED_TIER.LARGE, tenantTier: 'SPARK', passTier: 'LARGE', passActive: true, smsFrom: 'EVENT_PASS_BUNDLE' });
    expect(data.plan.settings).toMatchObject({ memoryHubEnabled: true, maxGuestsPerEvent: data.guestLimit.limit });
    expect(data.guestLimit.limit).toBe(Math.max(EVENT_PASS_GUEST_CAP.LARGE, TIER_VALUES.SPARK.maxGuestsPerEvent as number));
    expect(data.plan.settings).not.toHaveProperty('maxSmsPerMonth');
  });
});
