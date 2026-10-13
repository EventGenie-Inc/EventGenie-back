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
        maxMemoryHubBytesPerEvent: data.maxMemoryHubBytesPerEvent ?? null,
        emailEnabled: data.emailEnabled,
        smsEnabled: data.smsEnabled,
        vendorMarketplace: data.vendorMarketplace,
        memoryHubEnabled: data.memoryHubEnabled,
        dragDropBuilder: data.dragDropBuilder,
        guestExportEnabled: data.guestExportEnabled,
        publicEventsEnabled: data.publicEventsEnabled ?? false,
        paidTicketingEnabled: data.paidTicketingEnabled ?? false,
        customRsvpFieldsEnabled: data.customRsvpFieldsEnabled ?? false,
        vendorPriorityPlacement: data.vendorPriorityPlacement ?? false,
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
        ...(data.maxMemoryHubBytesPerEvent !== undefined && { maxMemoryHubBytesPerEvent: data.maxMemoryHubBytesPerEvent ?? null }),
        ...(data.emailEnabled !== undefined && { emailEnabled: data.emailEnabled }),
        ...(data.smsEnabled !== undefined && { smsEnabled: data.smsEnabled }),
        ...(data.vendorMarketplace !== undefined && { vendorMarketplace: data.vendorMarketplace }),
        ...(data.memoryHubEnabled !== undefined && { memoryHubEnabled: data.memoryHubEnabled }),
        ...(data.dragDropBuilder !== undefined && { dragDropBuilder: data.dragDropBuilder }),
        ...(data.guestExportEnabled !== undefined && { guestExportEnabled: data.guestExportEnabled }),
        ...(data.publicEventsEnabled !== undefined && { publicEventsEnabled: data.publicEventsEnabled }),
        ...(data.paidTicketingEnabled !== undefined && { paidTicketingEnabled: data.paidTicketingEnabled }),
        ...(data.customRsvpFieldsEnabled !== undefined && { customRsvpFieldsEnabled: data.customRsvpFieldsEnabled }),
        ...(data.vendorPriorityPlacement !== undefined && { vendorPriorityPlacement: data.vendorPriorityPlacement }),
        ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
      },
    }),

  setAvailability: (tier: SubscriptionTier, isAvailable: boolean) =>
    prisma.subscriptionTierConfig.update({
      where: { tier },
      data: { isAvailable },
    }),
};