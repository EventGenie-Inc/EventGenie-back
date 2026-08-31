import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateSubscriptionTierConfigDto, type UpdateSubscriptionTierConfigDto } from './subscription-tier-config.type.js';
import { type SubscriptionTier } from '@prisma/client';

export const subscriptionTierConfigRepository = {

  findAll: () =>
    prisma.subscriptionTierConfig.findMany({
      orderBy: { tier: 'asc' },
    }),

  findByTier: (tier: SubscriptionTier) =>
    prisma.subscriptionTierConfig.findUnique({
      where: { tier },
    }),

  create: (data: CreateSubscriptionTierConfigDto) =>
    prisma.subscriptionTierConfig.create({
      data: {
        tier: data.tier,
        maxEvents: data.maxEvents ?? null,
        maxGuestsPerEvent: data.maxGuestsPerEvent ?? null,
        maxSmsPerMonth: data.maxSmsPerMonth ?? null,
        maxVendorSpaces: data.maxVendorSpaces ?? null,
        emailEnabled: data.emailEnabled,
        smsEnabled: data.smsEnabled,
        vendorMarketplace: data.vendorMarketplace,
        memoryHubEnabled: data.memoryHubEnabled,
        dragDropBuilder: data.dragDropBuilder,
      },
    }),

  update: (tier: SubscriptionTier, data: UpdateSubscriptionTierConfigDto) =>
    prisma.subscriptionTierConfig.update({
      where: { tier },
      data: {
        ...(data.maxEvents !== undefined && { maxEvents: data.maxEvents ?? null }),
        ...(data.maxGuestsPerEvent !== undefined && { maxGuestsPerEvent: data.maxGuestsPerEvent ?? null }),
        ...(data.maxSmsPerMonth !== undefined && { maxSmsPerMonth: data.maxSmsPerMonth ?? null }),
        ...(data.maxVendorSpaces !== undefined && { maxVendorSpaces: data.maxVendorSpaces ?? null }),
        ...(data.emailEnabled !== undefined && { emailEnabled: data.emailEnabled }),
        ...(data.smsEnabled !== undefined && { smsEnabled: data.smsEnabled }),
        ...(data.vendorMarketplace !== undefined && { vendorMarketplace: data.vendorMarketplace }),
        ...(data.memoryHubEnabled !== undefined && { memoryHubEnabled: data.memoryHubEnabled }),
        ...(data.dragDropBuilder !== undefined && { dragDropBuilder: data.dragDropBuilder }),
        ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
      },
    }),

  setAvailability: (tier: SubscriptionTier, isAvailable: boolean) =>
    prisma.subscriptionTierConfig.update({
      where: { tier },
      data: { isAvailable },
    }),
};