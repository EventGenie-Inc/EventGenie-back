import { type SubscriptionTier } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { sendEmail } from '../../shared/messaging/email.engine.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { eventService } from '../event/event.service.js';
import { eventRepository } from '../event/event.repository.js';
import { withEffectiveStatus } from '../event/event-status.util.js';
import { earliestAllowedDayDate } from '../event-day/event-day-validation.util.js';
import { eventDuplicateService } from '../event-duplicate/event-duplicate.service.js';
import { customTierService } from '../custom-tier/custom-tier.service.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.types.js';
import { type CreateEventDto } from '../event/event.types.js';
import { eventGrantRepository } from './event-grant.repository.js';
import { buildGrantedEventEmail } from './event-grant-email.util.js';
import {
  EVENT_GRANT_ERROR_CODES as CODES,
  MAX_TENANTS_PER_REQUEST,
  type CreateEventGrantInput,
  type EventGrantView,
} from './event-grant.types.js';

// ─────────────────────────────────────────
//  GRANTED EVENTS (STEERING "Custom tiers"; behind customTiers)
//
//  TEMPLATES are events of the internal e-velope organisation
//  (Tenant.isInternal): built by the super admin with the ordinary event
//  routes (a super admin may edit any event), never visible to a tenant
//  (tenant scoping: no tenant's user is in that organisation).
//
//  A GRANT copies one template to chosen tenants, or to every tenant created
//  before allTenantsUntil (existing ones and sign-ups until then). Each
//  recipient's copy comes from the duplicate service (copyEvent with
//  `grant`): a DRAFT in the recipient's organisation, made by its first
//  active tenant admin, with the grant's feature set (a standard or custom
//  tier: per setting, the more generous of it and the tenant's own plan),
//  not counted against the event limit; never guests, never paid. Then an
//  email to the organisation's address that it's ready.
//
//  ONCE PER TENANT: one EventGrantRecipient per grant and tenant (unique),
//  claimed before the copy and marked DELIVERED in the copy's own
//  transaction. A failed copy is FAILED with its reason (the super admin
//  sees it, and choosing the tenant again retries it); a crash leaves it
//  PENDING, taken again by the sweep after the lease.
//
//  Chosen tenants are delivered in the request, one at a time. A grant to
//  all is delivered by the sweep (startEventGrantSweeps, every 5 minutes):
//  existing tenants on its first run, a new sign-up within minutes. Each
//  delivery is audit-logged against its tenant, as the grant's creator's
//  action.
// ─────────────────────────────────────────

const DELIVERY_LEASE_MS = 15 * 60 * 1000;
export const EVENT_GRANT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_GRANT_SWEEP_FIRST_RUN_DELAY_MS = 4 * 60 * 1000;
const SWEEP_BATCH = 50;
const STANDARD_TIERS: readonly SubscriptionTier[] = ['SPARK', 'CELEBRATE', 'ELEVATE'];

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const parseDate = (raw: unknown, now: Date): Date | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const match = typeof raw === 'string' ? DATE_ONLY.exec(raw.trim()) : null;
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match![3])) {
    throw new HttpError(422, "Choose the event's first date (YYYY-MM-DD).", CODES.DATE_INVALID);
  }
  if (date < earliestAllowedDayDate(now)) {
    throw new HttpError(422, "The event's first date has already passed. Choose today or a later date.", CODES.DATE_INVALID);
  }
  return date;
};

const internalTenant = async () => {
  const tenant = await eventGrantRepository.findInternalTenant();
  // The migration creates it; a database without it can't hold templates.
  if (!tenant) throw new HttpError(500, 'The internal e-velope organisation is missing.');
  return tenant;
};

type GrantRow = NonNullable<Awaited<ReturnType<typeof eventGrantRepository.findGrant>>>;

const toView = (grant: GrantRow): EventGrantView => ({
  id: grant.id,
  sourceEventId: grant.sourceEventId,
  sourceEventName: grant.sourceEvent.name,
  name: grant.name,
  firstDate: grant.firstDate,
  grantedTier: grant.grantedTier,
  grantedCustomTier: grant.grantedCustomTier,
  toAllTenants: grant.toAllTenants,
  allTenantsUntil: grant.allTenantsUntil,
  createdByUserId: grant.createdByUserId,
  createdAt: grant.createdAt,
  recipients: grant.recipients.map((r) => ({
    tenantId: r.tenantId,
    tenantName: r.tenant.name,
    status: r.status,
    eventId: r.eventId,
    failureReason: r.failureReason,
    deliveredAt: r.deliveredAt,
  })),
});

const parseTenantIds = async (raw: unknown): Promise<string[]> => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !id)) {
    throw new HttpError(422, 'tenantIds must be a list of organisation ids.', CODES.TENANT_UNKNOWN);
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_TENANTS_PER_REQUEST) {
    throw new HttpError(422, `Choose at most ${MAX_TENANTS_PER_REQUEST} organisations at a time.`, CODES.TENANT_UNKNOWN);
  }
  const found = await eventGrantRepository.findTenants(ids);
  const usable = new Set(found.filter((t) => !t.isInternal).map((t) => t.id));
  const unknown = ids.filter((id) => !usable.has(id));
  if (unknown.length) throw new HttpError(422, `These aren't organisations that can be given an event: ${unknown.join(', ')}.`, CODES.TENANT_UNKNOWN);
  return ids;
};

const deliveryFailure = (err: unknown): string =>
  err instanceof HttpError ? err.message : 'Something went wrong while copying the event.';

export const eventGrantService = {
  // GET /api/admin/event-templates/organisation: where templates live.
  getTemplateOrganisation: internalTenant,

  // GET /api/admin/event-templates: the internal organisation's events.
  listTemplates: async () => {
    const tenant = await internalTenant();
    return (await eventRepository.findAll(tenant.id, 'ALL')).map(withEffectiveStatus);
  },

  // POST /api/admin/event-templates: a new template, with POST /api/events'
  // body. Edited afterwards through the ordinary event routes (days,
  // program, questions, design, cover).
  createTemplate: async (body: CreateEventDto, actorUserId: string) => {
    const tenant = await internalTenant();
    const event = await eventService.create(tenant.id, actorUserId, body);
    await adminAuditService.record({
      actorUserId,
      tenantId: tenant.id,
      action: ADMIN_AUDIT_ACTIONS.EVENT_TEMPLATE_CREATED,
      details: { eventId: event.id, eventName: event.name },
    });
    return event;
  },

  list: async (): Promise<EventGrantView[]> => (await eventGrantRepository.findGrants()).map(toView),

  get: async (id: string): Promise<EventGrantView> => {
    const grant = await eventGrantRepository.findGrant(id);
    if (!grant) throw new HttpError(404, 'Grant not found', CODES.NOT_FOUND);
    return toView(grant);
  },

  // POST /api/admin/event-grants. 201 with the grant and its recipients so
  // far: the chosen tenants delivered now; a grant to all by the sweep.
  create: async (body: CreateEventGrantInput, actorUserId: string, now: Date = new Date()): Promise<EventGrantView> => {
    const b = body ?? {};
    const tenant = await internalTenant();
    const template = typeof b.sourceEventId === 'string' ? await eventGrantRepository.findTemplate(b.sourceEventId, tenant.id) : null;
    if (!template) throw new HttpError(404, 'Template not found. Choose one of the e-velope organisation\'s events.', CODES.TEMPLATE_NOT_FOUND);
    if (template.ticketing === 'PAID') {
      throw new HttpError(422, "A granted event can't sell tickets. Make the template free first.", CODES.TEMPLATE_PAID);
    }

    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : template.name;
    const firstDate = parseDate(b.firstDate, now);
    if (!firstDate && template.eventDays[0] && template.eventDays[0].date < earliestAllowedDayDate(now)) {
      throw new HttpError(422, "The template's first date has passed. Choose a first date for the copies.", CODES.DATE_INVALID);
    }

    // Exactly one plan: a standard tier, or an active custom tier.
    const hasTier = b.grantedTier !== undefined && b.grantedTier !== null;
    const hasCustom = b.grantedCustomTierId !== undefined && b.grantedCustomTierId !== null;
    if (hasTier === hasCustom) {
      throw new HttpError(422, 'Choose the feature set the event comes with: one standard tier or one custom tier.', CODES.PLAN_REQUIRED);
    }
    let grantedTier: SubscriptionTier | null = null;
    let grantedCustomTierId: string | null = null;
    if (hasTier) {
      if (typeof b.grantedTier !== 'string' || !STANDARD_TIERS.includes(b.grantedTier as SubscriptionTier)) {
        throw new HttpError(422, 'grantedTier must be SPARK, CELEBRATE or ELEVATE.', CODES.PLAN_REQUIRED);
      }
      grantedTier = b.grantedTier as SubscriptionTier;
    } else {
      grantedCustomTierId = (await customTierService.getAssignable(b.grantedCustomTierId)).id;
    }

    const tenantIds = await parseTenantIds(b.tenantIds);
    if (b.toAllTenants !== undefined && typeof b.toAllTenants !== 'boolean') throw new HttpError(422, 'toAllTenants must be true or false.');
    const toAllTenants = b.toAllTenants === true;
    let allTenantsUntil: Date | null = null;
    if (toAllTenants) {
      allTenantsUntil = typeof b.allTenantsUntil === 'string' ? parseClientDateTime(b.allTenantsUntil.trim()) : null;
      if (!allTenantsUntil || Number.isNaN(allTenantsUntil.getTime()) || allTenantsUntil <= now) {
        throw new HttpError(422, 'Choose until when new sign-ups get it (a date in the future).', CODES.RECIPIENTS_REQUIRED);
      }
    }
    if (!toAllTenants && tenantIds.length === 0) {
      throw new HttpError(422, 'Choose who gets the event: some organisations, or all of them.', CODES.RECIPIENTS_REQUIRED);
    }

    const { id } = await eventGrantRepository.createGrant({
      sourceEventId: template.id,
      name,
      firstDate,
      grantedTier,
      grantedCustomTierId,
      toAllTenants,
      allTenantsUntil,
      createdByUserId: actorUserId,
    });
    await adminAuditService.record({
      actorUserId,
      tenantId: null,
      action: ADMIN_AUDIT_ACTIONS.EVENT_GRANT_CREATED,
      details: { grantId: id, sourceEventId: template.id, name, firstDate, grantedTier, grantedCustomTierId, tenantIds, toAllTenants, allTenantsUntil },
    });

    for (const tenantId of tenantIds) await eventGrantService.deliver(id, tenantId, { retryFailed: true, now, actorUserId });
    return eventGrantService.get(id);
  },

  // POST /api/admin/event-grants/:id/recipients { tenantIds }: give it to
  // more chosen tenants (or try a FAILED one again). A tenant that already
  // has it is left as it is.
  addRecipients: async (grantId: string, body: { tenantIds?: unknown }, actorUserId: string, now: Date = new Date()): Promise<EventGrantView> => {
    await eventGrantService.get(grantId);
    const tenantIds = await parseTenantIds(body?.tenantIds);
    if (tenantIds.length === 0) throw new HttpError(422, 'Choose at least one organisation.', CODES.RECIPIENTS_REQUIRED);
    for (const tenantId of tenantIds) await eventGrantService.deliver(grantId, tenantId, { retryFailed: true, now, actorUserId });
    return eventGrantService.get(grantId);
  },

  // One tenant's copy: claimed, copied (the delivery marked in the copy's
  // transaction), audit-logged, emailed. Returns the outcome; never throws
  // for a copy that fails (that's recorded on the row).
  deliver: async (
    grantId: string,
    tenantId: string,
    { retryFailed, now = new Date(), actorUserId }: { retryFailed: boolean; now?: Date; actorUserId?: string }
  ): Promise<'DELIVERED' | 'FAILED' | 'SKIPPED'> => {
    const grant = await eventGrantRepository.findGrant(grantId);
    if (!grant) return 'SKIPPED';
    const recipientId = await eventGrantRepository.claim(grantId, tenantId, now, new Date(now.getTime() - DELIVERY_LEASE_MS), retryFailed);
    if (!recipientId) return 'SKIPPED';

    try {
      const tenant = await eventGrantRepository.findRecipientTenant(tenantId);
      if (!tenant || tenant.isInternal || tenant.isArchived) throw new HttpError(422, 'This organisation can no longer be given an event.');
      const admin = await eventGrantRepository.findTenantAdmin(tenantId);
      if (!admin) throw new HttpError(422, 'This organisation has no active admin to own the event.');

      const template = await eventGrantRepository.findTemplate(grant.sourceEventId, (await internalTenant()).id);
      if (!template) throw new HttpError(422, 'The template is no longer there.');
      const firstDate = grant.firstDate ?? template.eventDays[0]?.date ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      if (template.eventDays[0] && firstDate < earliestAllowedDayDate(now)) {
        throw new HttpError(422, "The event's first date has passed, so it wasn't copied.");
      }

      const { eventId } = await eventDuplicateService.copyEvent(
        grant.sourceEventId,
        {
          name: grant.name,
          firstDate,
          copyGuests: false,
          userId: admin.id,
          grant: {
            grantId,
            targetTenantId: tenantId,
            grantedTier: grant.grantedTier,
            grantedCustomTierId: grant.grantedCustomTierId,
            withinTransaction: async (tx, newEventId) => {
              await eventGrantRepository.markDelivered(tx, recipientId, newEventId, now);
              await adminAuditService.record(
                {
                  actorUserId: actorUserId ?? grant.createdByUserId,
                  tenantId,
                  action: ADMIN_AUDIT_ACTIONS.EVENT_GRANTED,
                  details: {
                    grantId,
                    eventId: newEventId,
                    eventName: grant.name,
                    sourceEventId: grant.sourceEventId,
                    grantedTier: grant.grantedTier,
                    grantedCustomTierId: grant.grantedCustomTierId,
                  },
                },
                tx
              );
            },
          },
        },
        now
      );

      const result = await sendEmail(buildGrantedEventEmail({ to: tenant.email, organisationName: tenant.name, eventId, eventName: grant.name }));
      if (!result.ok) console.error(`[event grants] the email for grant ${grantId} to tenant ${tenantId} failed: ${result.reason}`);
      return 'DELIVERED';
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error(`[event grants] grant ${grantId} to tenant ${tenantId} failed:`, err);
        reportError(err);
      }
      await eventGrantRepository.markFailed(recipientId, deliveryFailure(err));
      return 'FAILED';
    }
  },

  // Grants to all: every tenant created before allTenantsUntil that hasn't
  // got it; and any delivery a crash left PENDING. `tenantIds`: only these
  // tenants (tests run it scoped to their own).
  sweep: async ({ now = new Date(), tenantIds }: { now?: Date; tenantIds?: string[] } = {}) => {
    const outcome = { delivered: 0, failed: 0 };
    if (!isFeatureEnabled('customTiers')) return outcome;
    const count = (r: string) => {
      if (r === 'DELIVERED') outcome.delivered++;
      if (r === 'FAILED') outcome.failed++;
    };

    for (const grant of await eventGrantRepository.findAllTenantGrants()) {
      const awaiting = await eventGrantRepository.findTenantsAwaiting(grant.id, grant.allTenantsUntil!, SWEEP_BATCH, tenantIds);
      for (const tenant of awaiting) count(await eventGrantService.deliver(grant.id, tenant.id, { retryFailed: false, now }));
    }
    const stale = await eventGrantRepository.findStalePending(new Date(now.getTime() - DELIVERY_LEASE_MS), SWEEP_BATCH, tenantIds);
    for (const row of stale) count(await eventGrantService.deliver(row.grantId, row.tenantId, { retryFailed: false, now }));
    return outcome;
  },
};

export const startEventGrantSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await eventGrantService.sweep();
    } catch (err) {
      console.error('[event grants] sweep failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), EVENT_GRANT_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), EVENT_GRANT_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
