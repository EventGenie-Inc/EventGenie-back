import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import {} from './subscription-tier-config.type.js';
import {} from '@prisma/client';
export const subscriptionTierConfigService = {
    getAll: () => subscriptionTierConfigRepository.findAll(),
    getByTier: async (tier) => {
        const config = await subscriptionTierConfigRepository.findByTier(tier);
        if (!config)
            throw new Error(`No configuration found for tier: ${tier}`);
        return config;
    },
    create: async (data) => {
        const existing = await subscriptionTierConfigRepository.findByTier(data.tier);
        if (existing)
            throw new Error(`Configuration for tier ${data.tier} already exists`);
        return subscriptionTierConfigRepository.create(data);
    },
    update: async (tier, data) => {
        await subscriptionTierConfigService.getByTier(tier);
        return subscriptionTierConfigRepository.update(tier, data);
    },
    setAvailability: async (tier, isAvailable) => {
        await subscriptionTierConfigService.getByTier(tier);
        return subscriptionTierConfigRepository.setAvailability(tier, isAvailable);
    },
};
//# sourceMappingURL=subscription-tier-config.service.js.map