import { SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';

// ─────────────────────────────────────────
//  TIER CAPABILITIES
//
//  Features that used to be tied to a tier by NAME in code (Spark can't
//  make an event public, sell tickets or ask custom RSVP questions; only
//  Elevate's vendor spaces get priority placement). Each is now a boolean
//  column on SubscriptionTierConfig, so a SUPER_ADMIN can switch it on for
//  any tier, the free one included, and enforcement follows on the next
//  request.
//
//  The migration that added them set each tier to exactly what the code
//  used to do. A tier with no config row at all (a database the seed and
//  that migration never reached) falls back to that same old rule rather
//  than to "off", so a missing row never changes behaviour.
// ─────────────────────────────────────────

export type TierCapability =
  | 'publicEventsEnabled'
  | 'paidTicketingEnabled'
  | 'customRsvpFieldsEnabled'
  | 'vendorPriorityPlacement';

const DEFAULT_WITHOUT_CONFIG: Record<TierCapability, (tier: SubscriptionTier) => boolean> = {
  publicEventsEnabled: (tier) => tier !== 'SPARK',
  paidTicketingEnabled: (tier) => tier !== 'SPARK',
  customRsvpFieldsEnabled: (tier) => tier !== 'SPARK',
  vendorPriorityPlacement: (tier) => tier === 'ELEVATE',
};

export const resolveTierCapability = (
  config: Pick<SubscriptionTierConfig, TierCapability> | null | undefined,
  tier: SubscriptionTier,
  capability: TierCapability
): boolean => (config ? config[capability] : DEFAULT_WITHOUT_CONFIG[capability](tier));

// Every tier that has the capability, from one read of the (three-row)
// config table — for a caller that judges many tenants at once (vendor
// discovery's priority placement).
export const tiersWithCapability = async (capability: TierCapability): Promise<ReadonlySet<SubscriptionTier>> => {
  const configs = await subscriptionTierConfigRepository.findAll();
  return new Set(
    Object.values(SubscriptionTier).filter((tier) =>
      resolveTierCapability(configs.find((config) => config.tier === tier), tier, capability)
    )
  );
};

export const isTierCapabilityEnabled = async (tier: SubscriptionTier, capability: TierCapability): Promise<boolean> =>
  resolveTierCapability(await subscriptionTierConfigRepository.findByTier(tier), tier, capability);
