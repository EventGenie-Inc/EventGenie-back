import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { type SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import { createTenant, createActor, headersFor, installFirebaseMock, deleteTenantsDeep, type Actor } from '../helpers/team.js';
import prisma from '../../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  GET /api/tenants/me — planSettings. The frontend shows or locks
//  features from these, never from the plan's name, so they must be what
//  the server enforces: the tier's config row, or with no row the same
//  fallback the enforcement code uses. A setting of a switched-off feature
//  is left out.
//
//  The test database holds no tier configs unless a test writes them; this
//  file puts SPARK and ELEVATE back as it found them.
// ─────────────────────────────────────────

const TIERS: SubscriptionTier[] = ['SPARK', 'ELEVATE'];
let saved: SubscriptionTierConfig[] = [];
let tenantId: string;
let admin: Actor;

const me = async () => {
  const res = await request(app).get('/api/tenants/me').set(headersFor(admin));
  expect(res.status).toBe(200);
  return res.body.data.planSettings as Record<string, unknown>;
};

const onTier = (tier: SubscriptionTier) => prisma.tenant.update({ where: { id: tenantId }, data: { subscriptionTier: tier } });

beforeAll(async () => {
  saved = await prisma.subscriptionTierConfig.findMany({ where: { tier: { in: TIERS } } });
  tenantId = (await createTenant()).id;
  admin = await createActor('TENANT_ADMIN', tenantId);
  await onTier('SPARK');
}, 60000);

afterAll(async () => {
  await deleteTenantsDeep([tenantId]);
  for (const tier of TIERS) {
    const row = saved.find((c) => c.tier === tier);
    if (row) {
      const { tier: _tier, updatedAt: _updatedAt, ...values } = row;
      await prisma.subscriptionTierConfig.upsert({ where: { tier }, create: { tier, ...values }, update: values });
    } else {
      await prisma.subscriptionTierConfig.deleteMany({ where: { tier } });
    }
  }
}, 60000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/tenants/me — planSettings', () => {
  it('changing a setting for SPARK changes what /me returns', async () => {
    installFirebaseMock();
    await onTier('SPARK');
    const sparkRow = {
      maxEvents: 1,
      maxGuestsPerEvent: 50,
      maxSmsPerMonth: 0,
      maxVendorSpaces: 0,
      maxMemoryHubBytesPerEvent: 0,
      smsEnabled: false,
      memoryHubEnabled: false,
      guestExportEnabled: false,
      vendorMarketplace: false,
      publicEventsEnabled: false,
      paidTicketingEnabled: false,
      customRsvpFieldsEnabled: false,
      vendorPriorityPlacement: false,
    };
    await prisma.subscriptionTierConfig.upsert({ where: { tier: 'SPARK' }, create: { tier: 'SPARK', ...sparkRow }, update: sparkRow });
    expect(await me()).toEqual(sparkRow);

    const switchedOn = {
      maxGuestsPerEvent: 300,
      memoryHubEnabled: true,
      maxMemoryHubBytesPerEvent: 1024,
      guestExportEnabled: true,
      vendorMarketplace: true,
      publicEventsEnabled: true,
      paidTicketingEnabled: true,
      customRsvpFieldsEnabled: true,
      vendorPriorityPlacement: true,
    };
    await prisma.subscriptionTierConfig.update({ where: { tier: 'SPARK' }, data: switchedOn });
    expect(await me()).toEqual({ ...sparkRow, ...switchedOn });
  }, 60000);

  it('with no config row, the same fallback the server enforces with', async () => {
    installFirebaseMock();
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: { in: TIERS } } });

    await onTier('SPARK');
    expect(await me()).toEqual({
      maxEvents: null,
      maxGuestsPerEvent: null,
      maxSmsPerMonth: null,
      maxVendorSpaces: null,
      maxMemoryHubBytesPerEvent: null,
      smsEnabled: false,
      memoryHubEnabled: false,
      guestExportEnabled: false,
      vendorMarketplace: false,
      publicEventsEnabled: false,
      paidTicketingEnabled: false,
      customRsvpFieldsEnabled: false,
      vendorPriorityPlacement: false,
    });

    await onTier('ELEVATE');
    expect(await me()).toMatchObject({
      publicEventsEnabled: true,
      paidTicketingEnabled: true,
      customRsvpFieldsEnabled: true,
      vendorPriorityPlacement: true,
    });
    await onTier('SPARK');
  }, 60000);

  it('a switched-off feature’s settings are left out', async () => {
    installFirebaseMock();
    await onTier('SPARK');
    vi.stubEnv('FEATURES_DISABLED', 'vendors,sms,ticketing,publicEvents');
    const settings = await me();
    for (const key of ['maxVendorSpaces', 'vendorMarketplace', 'vendorPriorityPlacement', 'maxSmsPerMonth', 'smsEnabled', 'paidTicketingEnabled', 'publicEventsEnabled']) {
      expect(settings).not.toHaveProperty(key);
    }
    expect(Object.keys(settings).sort()).toEqual(
      ['customRsvpFieldsEnabled', 'guestExportEnabled', 'maxEvents', 'maxGuestsPerEvent', 'maxMemoryHubBytesPerEvent', 'memoryHubEnabled'].sort()
    );
  }, 60000);
});
