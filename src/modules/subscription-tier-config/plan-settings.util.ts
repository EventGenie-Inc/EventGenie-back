import { type SubscriptionTier } from '@prisma/client';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { resolveTierCapability } from './tier-capabilities.util.js';
import { isFeatureEnabled, type FeatureName } from '../../shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  PLAN SETTINGS — what a tenant's plan allows, for the frontend.
//
//  GET /api/tenants/me carries these so the frontend decides what to show
//  from the settings themselves, never from the plan's name: a SUPER_ADMIN
//  can switch any of them on for any tier, the free one included.
//
//  Each value is resolved exactly as the server enforces it, from the
//  tier's SubscriptionTierConfig row, with the same fallback when there is
//  no row: limits unlimited (null), the on/off features off, and the four
//  capability settings their old in-code rule (tier-capabilities.util.ts).
//  Change an enforcement point's fallback and this must change with it.
//
//  A setting that belongs to a switched-off feature is left out entirely,
//  never sent as false: a tenant is never told about a feature that isn't
//  on offer (STEERING "Feature flags").
//
//  This is the TENANT's plan. An Event Pass can raise an event's own
//  entitlement above it; event-scoped numbers (an event's guest limit)
//  come with the event (event.service.ts's getDetail).
// ─────────────────────────────────────────

export interface PlanSettings {
  maxEvents: number | null; // null = unlimited
  maxGuestsPerEvent: number | null;
  maxSmsPerMonth?: number | null;
  maxVendorSpaces?: number | null;
  maxMemoryHubBytesPerEvent: number | null;
  smsEnabled?: boolean;
  memoryHubEnabled: boolean;
  guestExportEnabled: boolean;
  vendorMarketplace?: boolean;
  publicEventsEnabled?: boolean;
  paidTicketingEnabled?: boolean;
  customRsvpFieldsEnabled: boolean;
  vendorPriorityPlacement?: boolean;
}

type FeatureSettingKey =
  | 'maxSmsPerMonth'
  | 'smsEnabled'
  | 'maxVendorSpaces'
  | 'vendorMarketplace'
  | 'vendorPriorityPlacement'
  | 'publicEventsEnabled'
  | 'paidTicketingEnabled';

// Which feature flag each optional setting belongs to.
const SETTING_FEATURE: Record<FeatureSettingKey, FeatureName> = {
  maxSmsPerMonth: 'sms',
  smsEnabled: 'sms',
  maxVendorSpaces: 'vendors',
  vendorMarketplace: 'vendors',
  vendorPriorityPlacement: 'vendors',
  publicEventsEnabled: 'publicEvents',
  paidTicketingEnabled: 'ticketing',
};

export const resolvePlanSettings = async (tier: SubscriptionTier): Promise<PlanSettings> => {
  const config = await subscriptionTierConfigRepository.findByTier(tier);

  const settings: PlanSettings = {
    maxEvents: config?.maxEvents ?? null,
    maxGuestsPerEvent: config?.maxGuestsPerEvent ?? null,
    maxSmsPerMonth: config?.maxSmsPerMonth ?? null,
    maxVendorSpaces: config?.maxVendorSpaces ?? null,
    maxMemoryHubBytesPerEvent: config?.maxMemoryHubBytesPerEvent ?? null,
    smsEnabled: config?.smsEnabled ?? false,
    memoryHubEnabled: config?.memoryHubEnabled ?? false,
    guestExportEnabled: config?.guestExportEnabled ?? false,
    vendorMarketplace: config?.vendorMarketplace ?? false,
    publicEventsEnabled: resolveTierCapability(config, tier, 'publicEventsEnabled'),
    paidTicketingEnabled: resolveTierCapability(config, tier, 'paidTicketingEnabled'),
    customRsvpFieldsEnabled: resolveTierCapability(config, tier, 'customRsvpFieldsEnabled'),
    vendorPriorityPlacement: resolveTierCapability(config, tier, 'vendorPriorityPlacement'),
  };

  for (const [key, feature] of Object.entries(SETTING_FEATURE) as [FeatureSettingKey, FeatureName][]) {
    if (!isFeatureEnabled(feature)) delete settings[key];
  }
  return settings;
};
