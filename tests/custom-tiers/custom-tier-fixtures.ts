import { randomUUID } from 'crypto';
import { type Prisma, type SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';
import prisma from '../../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  Custom tiers fixtures.
//
//  The standard tier rows are shared by every suite (STEERING §6): these
//  tests write known values for all three, after saving each row, and put
//  each back with an upsert of the whole saved row (or delete one only if it
//  wasn't there). Custom tiers, grants, requests and audit entries a test
//  makes are removed by it.
// ─────────────────────────────────────────

const MB = 1024 * 1024;
const TIERS: SubscriptionTier[] = ['SPARK', 'CELEBRATE', 'ELEVATE'];

const base = {
  maxDocumentBytesPerEvent: 500 * MB,
  maxDocumentBytesPerFile: 5 * MB,
  emailEnabled: true,
  dragDropBuilder: false,
  isAvailable: true,
};

export const TIER_VALUES: Record<SubscriptionTier, Omit<Prisma.SubscriptionTierConfigCreateInput, 'tier'>> = {
  SPARK: {
    ...base,
    maxEvents: 1,
    maxGuestsPerEvent: 2,
    maxSmsPerMonth: null,
    maxVendorSpaces: 0,
    maxMemoryHubBytesPerEvent: 0,
    smsEnabled: false,
    vendorMarketplace: false,
    memoryHubEnabled: false,
    guestExportEnabled: false,
    publicEventsEnabled: false,
    paidTicketingEnabled: false,
    customRsvpFieldsEnabled: false,
    vendorPriorityPlacement: false,
  },
  CELEBRATE: {
    ...base,
    maxEvents: 5,
    maxGuestsPerEvent: 300,
    maxSmsPerMonth: 100,
    maxVendorSpaces: 2,
    maxMemoryHubBytesPerEvent: 500 * MB,
    smsEnabled: true,
    vendorMarketplace: true,
    memoryHubEnabled: true,
    guestExportEnabled: true,
    publicEventsEnabled: true,
    paidTicketingEnabled: true,
    customRsvpFieldsEnabled: true,
    // On here and off on Elevate, on purpose: a standard tier with a pass
    // takes the pass's tier WHOLE (the rule before custom tiers), so a
    // Celebrate tenant with a Large pass has no priority placement, where a
    // per-setting merge would have given it.
    vendorPriorityPlacement: true,
  },
  ELEVATE: {
    ...base,
    maxEvents: null,
    maxGuestsPerEvent: null,
    maxSmsPerMonth: null,
    maxVendorSpaces: null,
    maxMemoryHubBytesPerEvent: null,
    smsEnabled: true,
    vendorMarketplace: true,
    memoryHubEnabled: true,
    guestExportEnabled: true,
    publicEventsEnabled: true,
    paidTicketingEnabled: true,
    customRsvpFieldsEnabled: true,
    vendorPriorityPlacement: false,
  },
};

let saved: SubscriptionTierConfig[] = [];

export const writeTierConfigs = async (): Promise<void> => {
  saved = await prisma.subscriptionTierConfig.findMany({ where: { tier: { in: TIERS } } });
  for (const tier of TIERS) {
    await prisma.subscriptionTierConfig.upsert({ where: { tier }, create: { tier, ...TIER_VALUES[tier] }, update: TIER_VALUES[tier] });
  }
};

export const restoreTierConfigs = async (): Promise<void> => {
  for (const tier of TIERS) {
    const row = saved.find((c) => c.tier === tier);
    if (row) {
      const { tier: _tier, ...values } = row;
      await prisma.subscriptionTierConfig.upsert({ where: { tier }, create: { tier, ...values }, update: values });
    } else {
      await prisma.subscriptionTierConfig.deleteMany({ where: { tier } });
    }
  }
};

// A custom tier with a unique name; settings default to the "Trial" below.
export const TRIAL_VALUES = {
  maxEvents: 2,
  maxGuestsPerEvent: 400,
  maxSmsPerMonth: null,
  maxVendorSpaces: 1,
  maxMemoryHubBytesPerEvent: 1000,
  maxDocumentBytesPerEvent: 2000,
  maxDocumentBytesPerFile: 100,
  emailEnabled: true,
  smsEnabled: false,
  vendorMarketplace: true,
  memoryHubEnabled: true,
  dragDropBuilder: false,
  guestExportEnabled: true,
  publicEventsEnabled: true,
  paidTicketingEnabled: false,
  customRsvpFieldsEnabled: true,
  vendorPriorityPlacement: true,
};

export const createCustomTier = (overrides: Partial<typeof TRIAL_VALUES> & { name?: string; isActive?: boolean } = {}) =>
  prisma.customTier.create({ data: { name: `Trial ${randomUUID().slice(0, 8)}`, ...TRIAL_VALUES, ...overrides } });

export const onCustomTier = (tenantId: string, customTierId: string, endsAt: Date | null = null) =>
  prisma.tenant.update({ where: { id: tenantId }, data: { customTierId, customTierEndsAt: endsAt, customTierAssignedAt: new Date() } });

// Everything these suites make around tenants that deleteTenantsDeep
// doesn't know about, then the custom tiers.
export const deleteCustomTierFixtures = async (opts: { tenantIds?: string[]; customTierIds?: string[]; grantIds?: string[] }): Promise<void> => {
  const tenantIds = opts.tenantIds ?? [];
  if (tenantIds.length) {
    const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
    await prisma.eventPass.deleteMany({ where: { eventId: { in: events.map((e) => e.id) } } });
    await prisma.adminAuditEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.customTierRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.eventGrantRecipient.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { customTierId: null } });
  }
  if (opts.grantIds?.length) {
    await prisma.event.updateMany({ where: { eventGrantId: { in: opts.grantIds } }, data: { eventGrantId: null, grantedCustomTierId: null } });
    await prisma.eventGrant.deleteMany({ where: { id: { in: opts.grantIds } } });
  }
  if (opts.customTierIds?.length) {
    await prisma.event.updateMany({ where: { grantedCustomTierId: { in: opts.customTierIds } }, data: { grantedCustomTierId: null } });
    await prisma.tenant.updateMany({ where: { customTierId: { in: opts.customTierIds } }, data: { customTierId: null } });
    await prisma.customTier.deleteMany({ where: { id: { in: opts.customTierIds } } });
  }
};
