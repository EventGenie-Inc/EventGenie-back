import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import{type CreateSubscriptionTierConfigDto, type UpdateSubscriptionTierConfigDto } from './subscription-tier-config.type.js';
import { normalizeTierLimits } from './tier-limit-validation.util.js';
import { resolveTierCapability, type TierCapability } from './tier-capabilities.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { type SubscriptionTier } from '@prisma/client';

const TIER_CAPABILITY_LABELS: Record<TierCapability, string> = {
  publicEventsEnabled: 'Public events',
  paidTicketingEnabled: 'Paid ticketing',
  customRsvpFieldsEnabled: 'Custom RSVP questions',
  vendorPriorityPlacement: 'Vendor priority placement',
};

// The capability settings (tier-capabilities.util.ts) are booleans or
// absent; anything else is a 422 rather than a Prisma type error (a 500).
const assertCapabilitySettings = (body: Partial<Record<TierCapability, unknown>>): void => {
  for (const [field, label] of Object.entries(TIER_CAPABILITY_LABELS) as [TierCapability, string][]) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      throw new HttpError(422, `${label} must be switched on or off (true or false).`);
    }
  }
};

export const subscriptionTierConfigService = {

  getAll: () => subscriptionTierConfigRepository.findAll(),

  getByTier: async (tier: SubscriptionTier) => {
    const config = await subscriptionTierConfigRepository.findByTier(tier);
    if (!config) throw new Error(`No configuration found for tier: ${tier}`);
    return config;
  },

  create: async (body: CreateSubscriptionTierConfigDto) => {
    assertCapabilitySettings(body);
    const data = normalizeTierLimits(body);
    // An omitted capability gets that tier's old in-code default, the same
    // value the migration that introduced it gave existing tiers.
    for (const field of Object.keys(TIER_CAPABILITY_LABELS) as TierCapability[]) {
      data[field] ??= resolveTierCapability(null, data.tier, field);
    }

    const existing = await subscriptionTierConfigRepository.findByTier(data.tier);
    if (existing) throw new Error(`Configuration for tier ${data.tier} already exists`);
    return subscriptionTierConfigRepository.create(data);
  },

  // A SUPER_ADMIN is the only writer of this table (subscription-tier-
  // config.router.ts is SUPER_ADMIN-only end to end), and maxVendorSpaces
  // is the exact number assertVendorSpaceCreatable/resolveVendorSpaceLimit
  // enforce/read at runtime (vendor-tier-enforcement.util.ts) — a change
  // here takes effect on the very next request, no redeploy needed.
  update: async (tier: SubscriptionTier, body: UpdateSubscriptionTierConfigDto) => {
    assertCapabilitySettings(body);
    const data = normalizeTierLimits(body);

    await subscriptionTierConfigService.getByTier(tier);
    return subscriptionTierConfigRepository.update(tier, data);
  },

  setAvailability: async (tier: SubscriptionTier, isAvailable: boolean) => {
    await subscriptionTierConfigService.getByTier(tier);
    return subscriptionTierConfigRepository.setAvailability(tier, isAvailable);
  },
};