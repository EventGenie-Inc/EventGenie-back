import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import{type CreateSubscriptionTierConfigDto, type UpdateSubscriptionTierConfigDto } from './subscription-tier-config.type.js';
import { assertValidTierLimit } from './tier-limit-validation.util.js';
import { type SubscriptionTier } from '@prisma/client';

export const subscriptionTierConfigService = {

  getAll: () => subscriptionTierConfigRepository.findAll(),

  getByTier: async (tier: SubscriptionTier) => {
    const config = await subscriptionTierConfigRepository.findByTier(tier);
    if (!config) throw new Error(`No configuration found for tier: ${tier}`);
    return config;
  },

  create: async (data: CreateSubscriptionTierConfigDto) => {
    if (data.maxVendorSpaces !== undefined) assertValidTierLimit(data.maxVendorSpaces, 'maxVendorSpaces');

    const existing = await subscriptionTierConfigRepository.findByTier(data.tier);
    if (existing) throw new Error(`Configuration for tier ${data.tier} already exists`);
    return subscriptionTierConfigRepository.create(data);
  },

  // A SUPER_ADMIN is the only writer of this table (subscription-tier-
  // config.router.ts is SUPER_ADMIN-only end to end), and maxVendorSpaces
  // is the exact number assertVendorSpaceCreatable/resolveVendorSpaceLimit
  // enforce/read at runtime (vendor-tier-enforcement.util.ts) — a change
  // here takes effect on the very next request, no redeploy needed.
  update: async (tier: SubscriptionTier, data: UpdateSubscriptionTierConfigDto) => {
    if (data.maxVendorSpaces !== undefined) assertValidTierLimit(data.maxVendorSpaces, 'maxVendorSpaces');

    await subscriptionTierConfigService.getByTier(tier);
    return subscriptionTierConfigRepository.update(tier, data);
  },

  setAvailability: async (tier: SubscriptionTier, isAvailable: boolean) => {
    await subscriptionTierConfigService.getByTier(tier);
    return subscriptionTierConfigRepository.setAvailability(tier, isAvailable);
  },
};