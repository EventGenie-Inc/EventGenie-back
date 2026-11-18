import { type EventVisibility, type EventTicketing, type Prisma } from '@prisma/client';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { resolveEventPlan, resolveTenantPlan, type ResolvedPlan } from './effective-plan.util.js';
import { launchLimitMessage, launchUnavailableMessage, tierRefusalMessage } from './tier-refusal-wording.util.js';

export interface EventTierCheckInput {
  visibility?: EventVisibility;
  ticketing?: EventTicketing;
  hasCustomRsvpFields?: boolean;
}

// Capability gates. These used to be tied to SPARK by name; they are now
// per-plan settings (SubscriptionTierConfig, or a custom tier), resolved by
// effective-plan.util.ts, so a Super Admin can switch any of them on for any
// tier. The plan is resolved only when the input asks for one of them.
const assertCapabilityGates = (plan: ResolvedPlan, input: EventTierCheckInput): void => {
  if (input.visibility === 'PUBLIC' && !plan.values.publicEventsEnabled) {
    throw new HttpError(403, tierRefusalMessage(
      `The ${plan.name} plan only supports private events. Upgrade your plan to make this event public.`,
      launchUnavailableMessage('Public events', { plural: true }),
      plan
    ));
  }
  if (input.ticketing === 'PAID' && !plan.values.paidTicketingEnabled) {
    throw new HttpError(403, paidTicketingRefusal(plan));
  }
  if (input.hasCustomRsvpFields && !plan.values.customRsvpFieldsEnabled) {
    throw new HttpError(403, tierRefusalMessage(
      `The ${plan.name} plan does not support additional fields. Upgrade your plan to add them.`,
      launchUnavailableMessage('Additional fields', { plural: true }),
      plan
    ));
  }
};

const asksForCapability = (input: EventTierCheckInput): boolean =>
  input.visibility === 'PUBLIC' || input.ticketing === 'PAID' || !!input.hasCustomRsvpFields;

// The capability gates against a plan already resolved: a granted event's
// copy is checked against the tenant's plan raised by its granted feature
// set (event-grant.service.ts).
export const assertPlanAllowsEvent = (plan: ResolvedPlan, input: EventTierCheckInput): void => assertCapabilityGates(plan, input);

// Shared with payment-account-readiness.util.ts, which refuses the same
// capability on the bank-details side.
export const paidTicketingRefusal = (plan: Pick<ResolvedPlan, 'name' | 'customTier'>, passHint = false): string =>
  tierRefusalMessage(
    `The ${plan.name} plan does not support paid ticketing. Upgrade your plan${passHint ? ', or buy an Event Pass for this event,' : ''} to sell tickets.`,
    launchUnavailableMessage('Paid ticketing'),
    plan
  );

// The plan's active-event limit, on creating an event and on restoring an
// archived one: told apart from the other tier 403s.
export const EVENT_LIMIT_REACHED = 'EVENT_LIMIT_REACHED';

// Called before creating a new event (POST /api/events and event-draft
// materialize). CREATION-TIME: correctly bound by the tenant's CURRENT
// effective tier (Subscription Billing batch) — a lapsed tenant cannot
// start a sixth event or a new PUBLIC/PAID one, exactly as a tenant who
// never upgraded couldn't. This never touches an event that already
// exists, so it cannot break one.
export const assertEventCreatable = async (tenantId: string, input: EventTierCheckInput): Promise<void> => {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  if (asksForCapability(input)) assertCapabilityGates(await resolveTenantPlan(tenant), input);
  await assertWithinEventLimit(tenantId);
};

// The plan's active-event limit alone, against the tenant's current
// effective tier: 403 EVENT_LIMIT_REACHED. assertEventCreatable runs it
// first, with every other refusal; each create path (POST /api/events, the
// wizard's materialize, duplicating an event) runs it AGAIN inside its
// write, with `tx`, after taking the tenant's event-creation lock
// (eventRepository.lockEventCreation), so two creations at once can't both
// pass a limit only one of them fits.
//
// maxEvents is read from the tenant's effective plan (a standard tier's
// config, or its custom tier) rather than hardcoded, so a Super Admin
// changing either takes effect immediately without a code change.
export const assertWithinEventLimit = async (tenantId: string, tx?: Prisma.TransactionClient): Promise<void> => {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  const plan = await resolveTenantPlan(tenant);
  const maxEvents = plan.values.maxEvents;
  if (maxEvents != null) {
    const activeCount = await eventRepository.countActive(tenantId, tx);
    if (activeCount >= maxEvents) {
      throw new HttpError(
        403,
        tierRefusalMessage(
          `The ${plan.name} plan allows a maximum of ${maxEvents} active event(s). Archive an existing event or upgrade your plan to create another.`,
          launchLimitMessage(`You've reached the limit of ${maxEvents} active event(s)`, 'Archive an event you no longer need'),
          plan
        ),
        EVENT_LIMIT_REACHED
      );
    }
  }
};

// Called before restoring an archived event (event.service.ts's reactivate,
// a super admin action): restoring makes it active again, so it is held to
// the same maxEvents as creating one, against the tenant's current
// effective tier. An event that has ever held an Event Pass isn't counted
// as active (countActive), so restoring one never reaches the limit, and
// neither is a granted event (custom tiers). Worded for whoever restores it,
// never for a guest.
export const assertEventRestorable = async (event: { tenantId: string; eventPass: unknown; eventGrantId: string | null }): Promise<void> => {
  if (event.eventPass || event.eventGrantId) return;
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  const plan = await resolveTenantPlan(tenant);
  const maxEvents = plan.values.maxEvents;
  if (maxEvents == null) return;
  if ((await eventRepository.countActive(event.tenantId)) < maxEvents) return;

  throw new HttpError(
    403,
    tierRefusalMessage(
      `This organisation's ${plan.name} plan allows a maximum of ${maxEvents} active event(s). Archive another of its events, then restore this one.`,
      `This organisation has reached its limit of ${maxEvents} active event(s) during its free trial. Archive another of its events, then restore this one.`,
      plan
    ),
    EVENT_LIMIT_REACHED
  );
};

// Called before updating an existing event (PUT /api/events/:id). No
// maxEvents check here — an update doesn't create a new event.
//
// EVENT-SCOPED (Event Pass batch) — unlike assertEventCreatable, this
// runs on an event that already EXISTS and may already hold an active
// pass, so it resolves entitlement via resolveEventEntitlement (the
// greater of the tenant's own effective tier and the event's pass)
// rather than resolveEffectiveTier alone. Takes the full fetched event
// (not a bare tenantId) so a missed call site fails to compile rather
// than silently falling back to tenant-only resolution.
//
// Still CREATION-adjacent, not access-time, and safe on effective
// entitlement: assertCapabilityGates only fires when
// visibility/ticketing is EXPLICITLY part of THIS update payload (see
// the conditional spreads at every call site — event.service.ts never
// includes a field the caller didn't send), so editing an unrelated
// field (name, description) on an event that is already PUBLIC/PAID
// never re-evaluates this gate at all. Only a genuine attempt to newly
// flip visibility to PUBLIC or ticketing to PAID is blocked for a
// lapsed-and-unpassed tenant — the event's EXISTING public/paid status,
// and everything guest-facing built on it (RSVPs, ticket purchases), is
// untouched by this function, which never runs on any guest-facing path.
//
// Flagged, not fixed (pre-existing, independent of this batch): a
// well-behaved frontend that always resends the event's CURRENT
// ticketing/visibility on every edit (rather than omitting unchanged
// fields) would re-trigger this gate on every save once a tenant lapses
// — even though nothing is actually changing. Fixing that needs this
// function to compare against the event's stored value, which is a
// larger signature change out of scope for subscription billing.
export const assertEventUpdatable = async (event: EntitlementDerivableEvent, input: EventTierCheckInput): Promise<void> => {
  if (!asksForCapability(input)) return;
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  assertCapabilityGates(await resolveEventPlan(tenant, event), input);
};
