import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import{type CreateSubscriptionTierConfigDto, type UpdateSubscriptionTierConfigDto } from './subscription-tier-config.type.js';
import { type SubscriptionTier } from '@prisma/client';

export const subscriptionTierConfigService = {

  getAll: () => subscriptionTierConfigRepository.findAll(),

  getByTier: async (tier: SubscriptionTier) => {
    const config = await subscriptionTierConfigRepository.findByTier(tier);
    if (!config) throw new Error(`No configuration found for tier: ${tier}`);
    return config;
  },

  create: async (data: CreateSubscriptionTierConfigDto) => {
    const existing = await subscriptionTierConfigRepository.findByTier(data.tier);
    if (existing) throw new Error(`Configuration for tier ${data.tier} already exists`);
    return subscriptionTierConfigRepository.create(data);
  },

  update: async (tier: SubscriptionTier, data: UpdateSubscriptionTierConfigDto) => {
    await subscriptionTierConfigService.getByTier(tier);
    return subscriptionTierConfigRepository.update(tier, data);
  },

  setAvailability: async (tier: SubscriptionTier, isAvailable: boolean) => {
    await subscriptionTierConfigService.getByTier(tier);
    return subscriptionTierConfigRepository.setAvailability(tier, isAvailable);
  },
};