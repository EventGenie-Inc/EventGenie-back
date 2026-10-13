import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import { assertEventCreatable, assertEventUpdatable } from '../../src/modules/subscription-tier-config/event-tier-enforcement.util.js';
import { assertTenantReadyToSellTickets } from '../../src/modules/payment-account/payment-account-readiness.util.js';
import { vendorService } from '../../src/modules/vendor/vendor.service.js';
import { createActor, headersFor, installFirebaseMock } from '../helpers/team.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestVendorSpace,
  deleteTestVendorSpace,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  FREE PILOT — features that were tied to a tier by name in code are now
//  SubscriptionTierConfig settings a SUPER_ADMIN can switch on for any
//  tier, the free one included: public events, paid ticketing, custom RSVP
//  questions, and vendor priority placement. Each one is switched here on
//  SPARK and shown to change access. A tier with no config row keeps the
//  old in-code rule.
//
//  The test database holds no tier configs unless a test writes them; this
//  file puts every tier back as it found it.
// ─────────────────────────────────────────

const TIERS: SubscriptionTier[] = ['SPARK', 'CELEBRATE', 'ELEVATE'];
let savedConfigs: SubscriptionTierConfig[] = [];

const setSpark = (values: Partial<Record<'publicEventsEnabled' | 'paidTicketingEnabled' | 'customRsvpFieldsEnabled' | 'vendorPriorityPlacement', boolean>>) =>
  prisma.subscriptionTierConfig.upsert({
    where: { tier: 'SPARK' },
    create: {
      tier: 'SPARK',
      publicEventsEnabled: false,
      paidTicketingEnabled: false,
      customRsvpFieldsEnabled: false,
      vendorPriorityPlacement: false,
      ...values,
    },
    update: {
      publicEventsEnabled: false,
      paidTicketingEnabled: false,
      customRsvpFieldsEnabled: false,
      vendorPriorityPlacement: false,
      ...values,
    },
  });

let tenantId: string; // SPARK
let userId: string;

const event = () => ({ id: randomUUID(), tenantId, eventPass: null, eventDays: [] });

const statusOf = async (fn: () => Promise<unknown>): Promise<number | 'ok'> => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500;
  }
};

beforeAll(async () => {
  savedConfigs = await prisma.subscriptionTierConfig.findMany();
  tenantId = (await createTestTenant()).id;
  userId = (await createTestUserRow({ role: 'TENANT_ADMIN', tenantId })).id;
}, 60000);

afterAll(async () => {
  await deleteTestUserRow(userId);
  await deleteTestTenant(tenantId);
  for (const tier of TIERS) {
    const saved = savedConfigs.find((c) => c.tier === tier);
    if (saved) {
      const { tier: _tier, updatedAt: _updatedAt, ...values } = saved;
      await prisma.subscriptionTierConfig.update({ where: { tier }, data: values });
    } else {
      await prisma.subscriptionTierConfig.deleteMany({ where: { tier } });
    }
  }
}, 60000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('each new tier setting changes access', () => {
  it('publicEventsEnabled: off refuses a public event on SPARK, on allows it', async () => {
    await setSpark({ publicEventsEnabled: false });
    expect(await statusOf(() => assertEventCreatable(tenantId, { visibility: 'PUBLIC' }))).toBe(403);
    await setSpark({ publicEventsEnabled: true });
    expect(await statusOf(() => assertEventCreatable(tenantId, { visibility: 'PUBLIC' }))).toBe('ok');
  }, 30000);

  it('paidTicketingEnabled: off refuses paid ticketing on SPARK, on allows it (event and payout checks)', async () => {
    await setSpark({ paidTicketingEnabled: false });
    expect(await statusOf(() => assertEventCreatable(tenantId, { ticketing: 'PAID' }))).toBe(403);
    expect(await statusOf(() => assertTenantReadyToSellTickets(tenantId))).toBe(403);

    await setSpark({ paidTicketingEnabled: true });
    expect(await statusOf(() => assertEventCreatable(tenantId, { ticketing: 'PAID' }))).toBe('ok');
    // Past the tier check, the next refusal is the missing payout account.
    expect(await statusOf(() => assertTenantReadyToSellTickets(tenantId))).toBe(422);
  }, 30000);

  it('customRsvpFieldsEnabled: off refuses custom RSVP questions on SPARK, on allows them', async () => {
    await setSpark({ customRsvpFieldsEnabled: false });
    expect(await statusOf(() => assertEventUpdatable(event(), { hasCustomRsvpFields: true }))).toBe(403);
    await setSpark({ customRsvpFieldsEnabled: true });
    expect(await statusOf(() => assertEventUpdatable(event(), { hasCustomRsvpFields: true }))).toBe('ok');
  }, 30000);

  it('vendorPriorityPlacement: a SPARK tenant’s vendor space ranks as priority only while SPARK has it', async () => {
    const space = await createTestVendorSpace(tenantId, userId);
    try {
      const isPriority = async () => {
        const spaces = await vendorService.getBrowseVendors(null);
        return spaces.find((s) => s.id === space.id)?.isPriority;
      };
      await setSpark({ vendorPriorityPlacement: false });
      expect(await isPriority()).toBe(false);
      await setSpark({ vendorPriorityPlacement: true });
      expect(await isPriority()).toBe(true);
    } finally {
      await deleteTestVendorSpace(space.id);
    }
  }, 30000);

  it('with no config row, each falls back to the old in-code rule', async () => {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'SPARK' } });
    expect(await statusOf(() => assertEventCreatable(tenantId, { visibility: 'PUBLIC' }))).toBe(403);
    expect(await statusOf(() => assertEventCreatable(tenantId, { ticketing: 'PAID' }))).toBe(403);
    expect(await statusOf(() => assertEventUpdatable(event(), { hasCustomRsvpFields: true }))).toBe(403);

    // An ELEVATE tenant with no ELEVATE row: everything allowed, as before.
    const elevate = await createTestTenant();
    await prisma.tenant.update({ where: { id: elevate.id }, data: { subscriptionTier: 'ELEVATE' } });
    try {
      await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'ELEVATE' } });
      expect(await statusOf(() => assertEventCreatable(elevate.id, { visibility: 'PUBLIC', ticketing: 'PAID', hasCustomRsvpFields: true }))).toBe('ok');
    } finally {
      await deleteTestTenant(elevate.id);
    }
  }, 30000);
});

describe('the super admin tier screen reads and writes the settings', () => {
  it('PUT /api/subscription-tiers/SPARK switches one on, and a non-boolean is 422', async () => {
    installFirebaseMock();
    const superAdmin = await createActor('SUPER_ADMIN', null);
    await setSpark({});
    try {
      const res = await request(app)
        .put('/api/subscription-tiers/SPARK')
        .set(headersFor(superAdmin))
        .send({ customRsvpFieldsEnabled: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        customRsvpFieldsEnabled: true,
        publicEventsEnabled: false,
        paidTicketingEnabled: false,
        vendorPriorityPlacement: false,
      });

      const bad = await request(app)
        .put('/api/subscription-tiers/SPARK')
        .set(headersFor(superAdmin))
        .send({ publicEventsEnabled: 'yes' });
      expect(bad.status).toBe(422);
      expect((await prisma.subscriptionTierConfig.findUniqueOrThrow({ where: { tier: 'SPARK' } })).publicEventsEnabled).toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: superAdmin.id } });
    }
  }, 30000);
});
