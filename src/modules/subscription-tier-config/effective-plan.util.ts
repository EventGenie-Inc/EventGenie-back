import { type SubscriptionTier } from '@prisma/client';
import { subscriptionTierConfigRepository, type TierConfigRow } from './subscription-tier-config.repository.js';
import { resolveTierCapability, tiersWithCapability, type TierCapability } from './tier-capabilities.util.js';
import { resolveEffectiveTier, type TenantSubscriptionState } from '../subscription/effective-tier.util.js';
import {
  isEventPassActive,
  resolveEventEntitlement,
  type EntitlementDerivableEvent,
} from '../event-pass/event-entitlement.util.js';
import { EVENT_PASS_GRANTED_TIER } from '../event-pass/event-pass-plans.config.js';
import { customTierRepository } from '../custom-tier/custom-tier.repository.js';
import { type CustomTierRow } from '../custom-tier/custom-tier.types.js';

// ─────────────────────────────────────────
//  THE EFFECTIVE PLAN — the one resolution every tier check goes through
//  (STEERING "Tier enforcement", "Custom tiers").
//
//  A tenant's plan is either a standard tier (Spark, Celebrate, Elevate:
//  SubscriptionTierConfig) or a custom tier (CustomTier), and every check
//  reads the plan's SETTINGS (PlanValues) from here, never a tier's name:
//
//  - resolvePlanIdentity (pure): which plan. A custom tier while assigned
//    and before its end date; otherwise the standard tier the billing state
//    gives (resolveEffectiveTier: grace, cancel-at-period-end), which is
//    Spark for a tenant whose custom tier has ended, since an active Paystack
//    subscription blocks the assignment.
//  - resolveTenantPlan: that plan's settings. Tenant-scoped checks (the
//    event limit, the vendor marketplace, /me's planSettings).
//  - resolveEventPlan: one event's settings. Event-scoped checks (guests,
//    SMS, Memory Hub, export, documents, public/paid/fields on an existing
//    event). The tenant's plan, raised by the event's Event Pass while
//    active and by its granted feature set (a granted event, EventGrant):
//      * a standard tier with only a pass: the pass rule exactly as before
//        (resolveEventEntitlement): the pass's tier when it ranks above the
//        tenant's, as a whole. A tenant on a standard tier is unaffected by
//        custom tiers.
//      * otherwise (a custom tier, or a granted event): PER SETTING, THE MORE
//        GENEROUS WINS: a switch is on if either has it, a limit is the
//        larger, and unlimited (null) beats any number. So a custom tier and
//        an Event Pass never take anything from each other: an event on a
//        "Free trial" with a Large pass gets Elevate's unlimited Memory Hub
//        and keeps the trial's own higher guest limit, if it has one.
//
//  A standard tier with no config row keeps the old fallback (limits
//  unlimited, switches off, the four capabilities their old in-code rule);
//  a custom tier always has its row (FK, never deleted).
// ─────────────────────────────────────────

export const PLAN_LIMIT_KEYS = [
  'maxEvents',
  'maxGuestsPerEvent',
  'maxSmsPerMonth',
  'maxVendorSpaces',
  'maxMemoryHubBytesPerEvent',
  'maxDocumentBytesPerEvent',
  'maxDocumentBytesPerFile',
] as const;

export const PLAN_SWITCH_KEYS = [
  'emailEnabled',
  'smsEnabled',
  'vendorMarketplace',
  'memoryHubEnabled',
  'dragDropBuilder',
  'guestExportEnabled',
  'publicEventsEnabled',
  'paidTicketingEnabled',
  'customRsvpFieldsEnabled',
  'vendorPriorityPlacement',
  'qrCheckInEnabled',
  // The invitation design editor (CANVAS designs): Elevate only at launch.
  'invitationDesignsEnabled',
] as const;

export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export type PlanSwitchKey = (typeof PLAN_SWITCH_KEYS)[number];

// Every setting of a plan, resolved: null = unlimited (one document: the
// upload route's ceiling).
export type PlanValues = Record<PlanLimitKey, number | null> & Record<PlanSwitchKey, boolean>;

export interface TenantPlanState extends TenantSubscriptionState {
  customTierId: string | null;
  customTierEndsAt: Date | null;
}

export type PlanIdentity =
  | { kind: 'STANDARD'; tier: SubscriptionTier }
  | { kind: 'CUSTOM'; customTierId: string; endsAt: Date | null };

export interface ResolvedPlan {
  // For messages and display: the standard tier's name ('CELEBRATE') or the
  // custom tier's own ('Free trial'). Never compared in code.
  name: string;
  // The standard tier; null on a custom tier.
  tier: SubscriptionTier | null;
  customTier: { id: string; name: string; description: string | null; endsAt: Date | null } | null;
  values: PlanValues;
}

const CAPABILITIES: readonly TierCapability[] = [
  'publicEventsEnabled',
  'paidTicketingEnabled',
  'customRsvpFieldsEnabled',
  'vendorPriorityPlacement',
  'qrCheckInEnabled',
];

export const isCustomTierCurrent = (tenant: Pick<TenantPlanState, 'customTierId' | 'customTierEndsAt'>, now: Date = new Date()): boolean =>
  !!tenant.customTierId && (tenant.customTierEndsAt === null || now < tenant.customTierEndsAt);

export const resolvePlanIdentity = (tenant: TenantPlanState, now: Date = new Date()): PlanIdentity =>
  isCustomTierCurrent(tenant, now)
    ? { kind: 'CUSTOM', customTierId: tenant.customTierId!, endsAt: tenant.customTierEndsAt }
    : { kind: 'STANDARD', tier: resolveEffectiveTier(tenant, now) };

// A standard tier's settings, with the no-row fallback every enforcement
// point used before (config?.x ?? null, !!config?.x, resolveTierCapability).
export const planValuesFromConfig = (config: Partial<TierConfigRow> | null, tier: SubscriptionTier): PlanValues => {
  const values = {} as PlanValues;
  for (const key of PLAN_LIMIT_KEYS) values[key] = config?.[key] ?? null;
  for (const key of PLAN_SWITCH_KEYS) values[key] = !!config?.[key];
  for (const key of CAPABILITIES) values[key] = !!resolveTierCapability(config as TierConfigRow | null, tier, key);
  return values;
};

export const planValuesFromCustomTier = (row: CustomTierRow): PlanValues => {
  const values = {} as PlanValues;
  for (const key of PLAN_LIMIT_KEYS) values[key] = row[key];
  for (const key of PLAN_SWITCH_KEYS) values[key] = row[key];
  return values;
};

// Per setting, the more generous of two plans.
export const mostGenerousPlanValues = (a: PlanValues, b: PlanValues): PlanValues => {
  const values = {} as PlanValues;
  for (const key of PLAN_LIMIT_KEYS) {
    const x = a[key];
    const y = b[key];
    values[key] = x === null || y === null ? null : Math.max(x, y);
  }
  for (const key of PLAN_SWITCH_KEYS) values[key] = a[key] || b[key];
  return values;
};

export const resolveStandardPlan = async (tier: SubscriptionTier): Promise<ResolvedPlan> => ({
  name: tier,
  tier,
  customTier: null,
  // Through the repository object, so a test's spy on findByTier is honoured.
  values: planValuesFromConfig(await subscriptionTierConfigRepository.findByTier(tier), tier),
});

const customPlan = (row: CustomTierRow, endsAt: Date | null): ResolvedPlan => ({
  name: row.name,
  tier: null,
  customTier: { id: row.id, name: row.name, description: row.description, endsAt },
  values: planValuesFromCustomTier(row),
});

export const resolveTenantPlan = async (tenant: TenantPlanState, now: Date = new Date()): Promise<ResolvedPlan> => {
  const identity = resolvePlanIdentity(tenant, now);
  if (identity.kind === 'CUSTOM') {
    const row = await customTierRepository.findById(identity.customTierId);
    // The FK makes a missing row impossible; if it ever were, the billing
    // state decides, as for a tenant with no custom tier.
    if (row) return customPlan(row, identity.endsAt);
    return resolveStandardPlan(resolveEffectiveTier(tenant, now));
  }
  return resolveStandardPlan(identity.tier);
};

// A granted event's own feature set (null: not a granted event).
export interface GrantedPlanFields {
  grantedTier: SubscriptionTier | null;
  grantedCustomTierId: string | null;
}

export const resolveGrantedPlanValues = async (event: GrantedPlanFields): Promise<PlanValues | null> => {
  if (event.grantedTier) return (await resolveStandardPlan(event.grantedTier)).values;
  if (event.grantedCustomTierId) {
    const row = await customTierRepository.findById(event.grantedCustomTierId);
    return row ? planValuesFromCustomTier(row) : null;
  }
  return null;
};

// Every plan that has a capability, standard and custom, from one read of
// each table — for a caller that judges many tenants at once (vendor
// discovery's priority placement, with resolvePlanIdentity per tenant).
// Retired custom tiers count: their tenants keep them until moved.
export const plansWithCapability = async (
  capability: TierCapability
): Promise<{ tiers: ReadonlySet<SubscriptionTier>; customTierIds: ReadonlySet<string> }> => ({
  tiers: await tiersWithCapability(capability),
  customTierIds: new Set((await customTierRepository.findAll()).filter((row) => row[capability]).map((row) => row.id)),
});

export const resolveEventPlan = async (
  tenant: TenantPlanState,
  event: EntitlementDerivableEvent,
  now: Date = new Date()
): Promise<ResolvedPlan> => {
  const tenantPlan = await resolveTenantPlan(tenant, now);
  const passActive = isEventPassActive(event, now);
  const granted = await resolveGrantedPlanValues(event);
  if (!passActive && !granted) return tenantPlan;

  // A standard tier with only an Event Pass: the pass rule as it always was.
  if (tenantPlan.tier !== null && !granted) return resolveStandardPlan(resolveEventEntitlement(tenant, event, now));

  // A custom tier, or a granted event: per setting, the more generous.
  let values = tenantPlan.values;
  if (passActive) values = mostGenerousPlanValues(values, (await resolveStandardPlan(EVENT_PASS_GRANTED_TIER[event.eventPass!.passTier])).values);
  if (granted) values = mostGenerousPlanValues(values, granted);
  return { ...tenantPlan, values };
};

// The name resolveEventPlan gives an event, worked out without reading any
// plan's settings: for a list of many events at once (the super admin's
// events list, admin-console.service.ts). `customTierName` is the tenant's
// custom tier's name, read with the tenant (null when it has none). Display
// only, like ResolvedPlan.name. Kept to resolveEventPlan's rules: a custom
// tier, or a granted event, is named by the tenant's plan; a standard tier
// with only an active Event Pass by the pass rule's tier.
export const resolveEventPlanName = (
  tenant: TenantPlanState,
  customTierName: string | null,
  event: EntitlementDerivableEvent,
  now: Date = new Date()
): string => {
  const identity = resolvePlanIdentity(tenant, now);
  if (identity.kind === 'CUSTOM' && customTierName !== null) return customTierName;
  const granted = event.grantedTier !== null || event.grantedCustomTierId !== null;
  if (!granted && isEventPassActive(event, now)) return resolveEventEntitlement(tenant, event, now);
  return resolveEffectiveTier(tenant, now);
};
