import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { isUniqueViolationOn } from '../../shared/utils/prisma-error.util.js';
import { normalizeTierLimits, type TierLimitField } from '../subscription-tier-config/tier-limit-validation.util.js';
import { isCustomTierCurrent, PLAN_LIMIT_KEYS, PLAN_SWITCH_KEYS } from '../subscription-tier-config/effective-plan.util.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.types.js';
import { customTierRepository } from './custom-tier.repository.js';
import { subscriptionService } from '../subscription/subscription.service.js';
import {
  CUSTOM_TIER_ERROR_CODES as CODES,
  type AssignCustomTierInput,
  type CustomTierInput,
  type CustomTierRow,
  type CustomTierView,
} from './custom-tier.types.js';

// ─────────────────────────────────────────
//  CUSTOM TIERS (STEERING "Custom tiers") — the super admin's own tiers.
//
//  Created, edited and retired here (never deleted: a retired tier can't be
//  assigned, and tenants already on it keep it until moved). Assigned to a
//  tenant, with an optional end date, and taken off again. What a tier
//  allows is enforced through effective-plan.util.ts, like every plan.
//
//  Every change is audit-logged (admin-audit.service.ts): the tier's own
//  changes with no tenant, an assignment against its tenant, in the same
//  transaction as the change.
// ─────────────────────────────────────────

const NAME_MAX_LENGTH = 60;
const DESCRIPTION_MAX_LENGTH = 300;

const SWITCH_LABELS: Record<(typeof PLAN_SWITCH_KEYS)[number], string> = {
  emailEnabled: 'Email',
  smsEnabled: 'SMS',
  vendorMarketplace: 'Vendor marketplace',
  memoryHubEnabled: 'Memory Hub',
  dragDropBuilder: 'Drag and drop builder',
  guestExportEnabled: 'Guest list export',
  publicEventsEnabled: 'Public events',
  paidTicketingEnabled: 'Paid ticketing',
  customRsvpFieldsEnabled: 'Additional fields',
  vendorPriorityPlacement: 'Vendor priority placement',
  qrCheckInEnabled: 'QR check-in',
};

// The checked settings of a create or edit: only what was sent.
const parseSettings = async (body: CustomTierInput, { creating, id }: { creating: boolean; id?: string }) => {
  const data: Record<string, unknown> = {};

  if (body.name !== undefined || creating) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX_LENGTH) {
      throw new HttpError(422, `Give the tier a name of up to ${NAME_MAX_LENGTH} characters.`, CODES.NAME_REQUIRED);
    }
    const existing = await customTierRepository.findByNameInsensitive(name);
    if (existing && existing.id !== id) {
      throw new HttpError(409, `There's already a tier called ${existing.name}.`, CODES.NAME_TAKEN);
    }
    data['name'] = name;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') throw new HttpError(422, 'The description must be text.');
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      throw new HttpError(422, `Keep the description to ${DESCRIPTION_MAX_LENGTH} characters.`);
    }
    data['description'] = description || null;
  }

  // Limits: the standard tiers' rules (a whole number of 0 or more, null for
  // unlimited; one document at most the upload ceiling).
  const limits = normalizeTierLimits(
    Object.fromEntries(PLAN_LIMIT_KEYS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) as Partial<Record<TierLimitField, unknown>>
  );
  Object.assign(data, limits);

  for (const key of PLAN_SWITCH_KEYS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new HttpError(422, `${SWITCH_LABELS[key]} must be switched on or off (true or false).`);
    data[key] = body[key];
  }

  if (body.isActive !== undefined) {
    if (creating) throw new HttpError(422, 'A new tier is always active; retire it afterwards.');
    if (typeof body.isActive !== 'boolean') throw new HttpError(422, 'isActive must be true or false.');
    data['isActive'] = body.isActive;
  }
  return data;
};

// "2026-12-31": the end of that UTC day (the tier lasts through it); a date
// and time: that moment. Null or left out: no end. Must be in the future.
export const parseEndsAt = (raw: unknown, now: Date): Date | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  const invalid = new HttpError(422, 'Choose an end date in the future, or none.', CODES.END_DATE_INVALID);
  if (typeof raw !== 'string') throw invalid;
  const value = raw.trim();
  const endsAt = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(new Date(`${value}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000 - 1)
    : parseClientDateTime(value);
  if (Number.isNaN(endsAt.getTime()) || endsAt <= now) throw invalid;
  return endsAt;
};

const notFound = (): HttpError => new HttpError(404, 'Custom tier not found', CODES.NOT_FOUND);

export const customTierService = {
  // GET /api/admin/custom-tiers: every tier, active first, with how many
  // tenants are on it now.
  list: async (now: Date = new Date()): Promise<CustomTierView[]> => {
    const [tiers, counts] = await Promise.all([customTierRepository.findAll(), customTierRepository.countCurrentTenantsByTier(now)]);
    return tiers.map((tier) => ({ ...tier, tenantCount: counts.get(tier.id) ?? 0 }));
  },

  get: async (id: string): Promise<CustomTierRow> => {
    const tier = await customTierRepository.findById(id);
    if (!tier) throw notFound();
    return tier;
  },

  create: async (body: CustomTierInput, actorUserId: string): Promise<CustomTierRow> => {
    const data = await parseSettings(body ?? {}, { creating: true });
    try {
      return await prisma.$transaction(async (tx) => {
        const created = await customTierRepository.create(data as Prisma.CustomTierCreateInput, tx);
        await adminAuditService.record(
          { actorUserId, tenantId: null, action: ADMIN_AUDIT_ACTIONS.CUSTOM_TIER_CREATED, details: { customTierId: created.id, after: created } },
          tx
        );
        return created;
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'CustomTier', 'name')) throw new HttpError(409, 'There\'s already a tier with that name.', CODES.NAME_TAKEN);
      throw err;
    }
  },

  // Edits apply at once to every tenant on the tier (and every event granted
  // with it). isActive false retires it, true brings it back.
  update: async (id: string, body: CustomTierInput, actorUserId: string): Promise<CustomTierRow> => {
    const before = await customTierService.get(id);
    const data = await parseSettings(body ?? {}, { creating: false, id });
    if (Object.keys(data).length === 0) return before;
    try {
      return await prisma.$transaction(async (tx) => {
        const after = await customTierRepository.update(id, data as Prisma.CustomTierUpdateInput, tx);
        await adminAuditService.record(
          { actorUserId, tenantId: null, action: ADMIN_AUDIT_ACTIONS.CUSTOM_TIER_UPDATED, details: { customTierId: id, changed: Object.keys(data), before, after } },
          tx
        );
        return after;
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'CustomTier', 'name')) throw new HttpError(409, 'There\'s already a tier with that name.', CODES.NAME_TAKEN);
      throw err;
    }
  },

  // An active tier, for assigning (to a tenant or a grant): a retired one is
  // 422 CUSTOM_TIER_RETIRED.
  getAssignable: async (id: unknown): Promise<CustomTierRow> => {
    const tier = typeof id === 'string' && id ? await customTierRepository.findById(id) : null;
    if (!tier) throw notFound();
    if (!tier.isActive) {
      throw new HttpError(422, `${tier.name} is retired, so it can't be assigned. Choose an active tier.`, CODES.RETIRED);
    }
    return tier;
  },

  // PUT /api/admin/tenants/:tenantId/custom-tier
  //   { customTierId, endsAt?: 'YYYY-MM-DD' | ISO date-time | null, confirmSubscriptionCancelled?: boolean }
  // Moves the tenant onto the tier now (or changes its tier or end date).
  // A tenant with an active Paystack subscription is refused, 409
  // CUSTOM_TIER_ACTIVE_SUBSCRIPTION, until the super admin has cancelled it
  // and says so (confirmSubscriptionCancelled: true): its billing state is
  // then cleared to Spark in the same write, so it's back on Spark when the
  // custom tier ends or is taken off.
  assign: async (tenantId: string, body: AssignCustomTierInput, actorUserId: string, now: Date = new Date()) => {
    const b = body ?? {};
    const tier = await customTierService.getAssignable(b.customTierId);
    const endsAt = parseEndsAt(b.endsAt, now);
    if (b.confirmSubscriptionCancelled !== undefined && typeof b.confirmSubscriptionCancelled !== 'boolean') {
      throw new HttpError(422, 'confirmSubscriptionCancelled must be true or false.');
    }

    return prisma.$transaction(async (tx) => {
      await customTierRepository.lockTenant(tx, tenantId);
      const tenant = await customTierRepository.findTenantForAssignment(tenantId, tx);
      if (!tenant) throw new HttpError(404, 'Tenant not found');
      if (tenant.isInternal) {
        throw new HttpError(422, "The internal e-velope organisation can't be put on a custom tier.", CODES.INTERNAL_TENANT);
      }

      // The same test subscribe uses: a Paystack subscription that will renew.
      const activeSubscription = !!tenant.paystackSubscriptionCode && !tenant.subscriptionCancelAtPeriodEnd;
      if (activeSubscription && b.confirmSubscriptionCancelled !== true) {
        throw new HttpError(
          409,
          `${tenant.name} has an active ${tenant.subscriptionTier} subscription through Paystack. Cancel it first, then confirm it's cancelled to move them onto ${tier.name}.`,
          CODES.ACTIVE_SUBSCRIPTION
        );
      }

      const previous = { customTierId: tenant.customTierId, endsAt: tenant.customTierEndsAt, current: isCustomTierCurrent(tenant, now) };
      const updated = await customTierRepository.assign(tenantId, { customTierId: tier.id, endsAt, now, resetBilling: activeSubscription }, tx);

      await adminAuditService.record(
        {
          actorUserId,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.CUSTOM_TIER_ASSIGNED,
          details: {
            customTierId: tier.id,
            customTierName: tier.name,
            endsAt,
            previous,
            ...(activeSubscription && {
              subscriptionConfirmedCancelled: true,
              cancelledSubscription: { tier: tenant.subscriptionTier, period: tenant.subscriptionPeriod, currentPeriodEnd: tenant.subscriptionCurrentPeriodEnd },
            }),
          },
        },
        tx
      );

      return {
        tenantId,
        customTier: { id: tier.id, name: tier.name, description: tier.description, endsAt: updated.customTierEndsAt },
        assignedAt: updated.customTierAssignedAt,
      };
    });
  },

  // DELETE /api/admin/tenants/:tenantId/custom-tier: back off the custom tier,
  // onto whatever their billing gives them (Spark, normally). Taking off a
  // tenant with none is a no-op that still answers 200.
  unassign: async (tenantId: string, actorUserId: string, now: Date = new Date()) =>
    prisma.$transaction(async (tx) => {
      await customTierRepository.lockTenant(tx, tenantId);
      const tenant = await customTierRepository.findTenantForAssignment(tenantId, tx);
      if (!tenant) throw new HttpError(404, 'Tenant not found');
      if (!tenant.customTierId) return { tenantId, customTier: null };

      await customTierRepository.unassign(tenantId, tx);
      // Back on what its billing gives: Spark, normally. Billing fields left
      // over from a subscription that has ended are cleared, so nothing
      // claims a plan "ends" (subscription-state.util.ts).
      await subscriptionService.settleIfEnded(tenantId, 'CUSTOM_TIER_REMOVED', now, tx);
      await adminAuditService.record(
        {
          actorUserId,
          tenantId,
          action: ADMIN_AUDIT_ACTIONS.CUSTOM_TIER_REMOVED,
          details: { customTierId: tenant.customTierId, endsAt: tenant.customTierEndsAt, wasCurrent: isCustomTierCurrent(tenant, now) },
        },
        tx
      );
      return { tenantId, customTier: null };
    }),
};
