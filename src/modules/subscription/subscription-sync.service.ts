import { type Prisma } from '@prisma/client';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PENDING_CHECKOUT_REUSE_MS } from '../../shared/payments/pending-checkout.util.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { withPaymentContext } from '../payment-webhook/payment-context.util.js';
import { subscriptionRepository } from './subscription.repository.js';
import { subscriptionService } from './subscription.service.js';
import { resolveTierAndPeriodFromPlanCode } from './subscription-plans.config.js';

type BillingTenant = NonNullable<Awaited<ReturnType<typeof subscriptionRepository.findBillingStateByTenantId>>>;

const LIVE_STATUSES = new Set(['active', 'non-renewing', 'attention']);
const ENDED_STATUSES = new Set(['cancelled', 'completed']);

const snapshot = (t: BillingTenant) => ({
  tier: t.subscriptionTier,
  period: t.subscriptionPeriod,
  currentPeriodEnd: t.subscriptionCurrentPeriodEnd,
  cancelAtPeriodEnd: t.subscriptionCancelAtPeriodEnd,
  graceStartedAt: t.subscriptionGraceStartedAt,
  subscriptionCode: t.paystackSubscriptionCode,
  pendingTier: t.subscriptionPendingTier,
  pendingPeriod: t.subscriptionPendingPeriod,
});

const isValidDate = (value: string | null | undefined): value is string =>
  typeof value === 'string' && !Number.isNaN(new Date(value).getTime());

// ─────────────────────────────────────────
//  SUBSCRIPTION SYNC (payments release 1)
//
//  Reads a tenant's subscription from Paystack and corrects the tenant when
//  the two disagree. Webhooks remain the normal path; this catches what they
//  missed or what couldn't finish:
//   - a subscription Paystack made that we never heard of (an upgrade with
//     no clear answer, a subscription.create that never arrived): adopted
//     through the same handler as the webhook, if it is the plan the tenant
//     asked for;
//   - a refunded subscription still to be disabled at Paystack: disabled;
//   - Paystack "active": the period end it reports, grace cleared;
//   - Paystack "attention" (a renewal failing): grace started;
//   - Paystack "non-renewing" / "cancelled" / "completed": access ends at
//     the period end (cancelAtPeriodEnd).
//  Every correction is one SUBSCRIPTION_SYNC_CORRECTED ledger row with the
//  before and after. Run hourly for flagged tenants (subscriptionNeedsSync)
//  and daily for every tenant with a subscription
//  (payment-maintenance.service.ts); also from POST /api/subscriptions/verify.
// ─────────────────────────────────────────
export const subscriptionSyncService = {
  // A live subscription at Paystack for the plan this tenant asked for
  // (its pending attempt) that we never activated: activate it now, through
  // the subscription.create handler (same checks: amount, duplicates).
  adoptUnseenSubscription: async (tenant: BillingTenant, customerCode: string): Promise<boolean> => {
    if (!tenant.subscriptionPendingTier || !tenant.subscriptionPendingPeriod) return false;
    const customer = await paystackClient.getCustomerSubscriptions(customerCode);
    for (const listed of customer.subscriptions) {
      if (listed.subscriptionCode === tenant.paystackSubscriptionCode) continue;
      if (!LIVE_STATUSES.has(listed.status)) continue;
      const full = listed.planCode && listed.emailToken && listed.nextPaymentDate ? listed : await paystackClient.getSubscription(listed.subscriptionCode);
      const resolved = full.planCode ? resolveTierAndPeriodFromPlanCode(full.planCode) : null;
      if (!resolved || resolved.tier !== tenant.subscriptionPendingTier || resolved.period !== tenant.subscriptionPendingPeriod) continue;
      if (!isValidDate(full.nextPaymentDate) || !full.emailToken) continue;

      const data: Record<string, unknown> = {
        subscription_code: full.subscriptionCode,
        email_token: full.emailToken,
        next_payment_date: full.nextPaymentDate,
        status: full.status,
        customer: { email: tenant.email, customer_code: customerCode },
        plan: { plan_code: full.planCode },
        authorization: {
          ...(full.authorizationCode && { authorization_code: full.authorizationCode }),
          ...(full.cardBrand && { card_type: full.cardBrand }),
          ...(full.cardLast4 && { last4: full.cardLast4 }),
          ...(full.cardExpMonth && { exp_month: full.cardExpMonth }),
          ...(full.cardExpYear && { exp_year: full.cardExpYear }),
        },
        adoptedBySync: true,
      };
      const result = await withPaymentContext('subscription.create', data, (ctx) =>
        subscriptionService.handleSubscriptionCreateWithinTransaction(ctx)
      );
      if (result.claimed) return true;
    }
    return false;
  },

  syncTenant: async (initial: BillingTenant, now: Date = new Date()): Promise<{ changes: string[] }> => {
    const changes: string[] = [];
    const before = snapshot(initial);
    let tenant = initial;
    let paystackStatus: string | null = null;

    // 1. A subscription asked for (a checkout, a plan change) and never seen.
    if (tenant.paystackCustomerCode && tenant.subscriptionPendingTier) {
      if (await subscriptionSyncService.adoptUnseenSubscription(tenant, tenant.paystackCustomerCode)) {
        changes.push('ADOPTED_UNSEEN_SUBSCRIPTION');
        tenant = (await subscriptionRepository.findBillingStateByTenantId(tenant.id)) ?? tenant;
      }
    }
    // A plan change that Paystack never turned into a subscription, past
    // the reuse window: there is nothing to wait for.
    const reference = tenant.subscriptionPendingReference;
    const pendingAge = tenant.subscriptionPendingStartedAt ? now.getTime() - tenant.subscriptionPendingStartedAt.getTime() : Infinity;
    if (reference?.startsWith('upg_') && pendingAge > PENDING_CHECKOUT_REUSE_MS) {
      await subscriptionRepository.clearPendingAttempt(tenant.id, undefined, reference);
      changes.push('CLEARED_UNCONFIRMED_PLAN_CHANGE');
    }

    // 2. The current subscription, as Paystack has it.
    const code = tenant.paystackSubscriptionCode;
    if (code) {
      const sub = await paystackClient.getSubscription(code);
      paystackStatus = sub.status;

      if (tenant.subscriptionTier === 'SPARK') {
        // Refunded or otherwise ended here: it must not stay live there.
        if (LIVE_STATUSES.has(sub.status) && tenant.paystackSubscriptionEmailToken) {
          await paystackClient.disableSubscription(code, tenant.paystackSubscriptionEmailToken);
          await subscriptionRepository.clearSubscriptionCodes(tenant.id, code);
          changes.push('DISABLED_ENDED_SUBSCRIPTION');
        } else if (ENDED_STATUSES.has(sub.status)) {
          await subscriptionRepository.clearSubscriptionCodes(tenant.id, code);
          changes.push('CLEARED_ENDED_SUBSCRIPTION');
        }
      } else if (sub.status === 'active') {
        if (isValidDate(sub.nextPaymentDate)) {
          const next = new Date(sub.nextPaymentDate);
          if (tenant.subscriptionCurrentPeriodEnd?.getTime() !== next.getTime()) {
            await subscriptionRepository.updateCurrentPeriodEnd(tenant.id, next);
            changes.push('PERIOD_END_UPDATED');
          }
        }
        if (tenant.subscriptionGraceStartedAt) {
          await subscriptionRepository.clearGrace(tenant.id);
          changes.push('GRACE_CLEARED');
        }
        if (tenant.subscriptionCancelAtPeriodEnd) {
          // We think it ends; Paystack will renew it. Not corrected
          // automatically: a person decides.
          changes.push('PAYSTACK_STILL_ACTIVE_AFTER_CANCEL');
          await paymentAlertService.send({
            kind: 'SYNC',
            subject: 'A cancelled subscription is still active at Paystack',
            lines: [
              "This tenant's subscription is set to end, but Paystack still shows it active and will renew it.",
              "Disable it in Paystack's dashboard, or check whether the tenant resubscribed.",
            ],
            facts: [`Tenant: ${tenant.id}`, `Subscription: ${code}`],
          });
        }
      } else if (sub.status === 'attention') {
        if (!tenant.subscriptionGraceStartedAt) {
          await subscriptionRepository.recordChargeFailureIfFirst(tenant.id);
          changes.push('GRACE_STARTED');
        }
      } else if (sub.status === 'non-renewing' || ENDED_STATUSES.has(sub.status)) {
        if (!tenant.subscriptionCancelAtPeriodEnd) {
          await subscriptionRepository.setCancelAtPeriodEnd(tenant.id);
          changes.push('SET_TO_END_AT_PERIOD_END');
        }
      }
    }

    // On Spark with nothing live left (a subscription Paystack ended, a
    // cancelled one past its period): its stale fields cleared, in its own
    // ledger row (subscriptionService.settleIfEnded).
    if (await subscriptionService.settleIfEnded(tenant.id, 'SYNC', now)) changes.push('SETTLED_ON_SPARK');

    // In step now, unless a refunded subscription is still live at Paystack
    // (its disable failed above, or it had no token): stays flagged.
    const after = await subscriptionRepository.findBillingStateByTenantId(tenant.id);
    if (after && !(after.subscriptionTier === 'SPARK' && after.paystackSubscriptionCode)) {
      await subscriptionRepository.markSynced(tenant.id);
    }

    if (changes.length > 0) {
      const final = (await subscriptionRepository.findBillingStateByTenantId(tenant.id)) ?? tenant;
      await paymentLedgerService.record({
        type: 'SUBSCRIPTION_SYNC_CORRECTED',
        amountCents: 0,
        currency: 'ZAR',
        tenantId: tenant.id,
        paystackReference: code,
        relatedType: 'Tenant',
        relatedId: tenant.id,
        payload: { changes, paystackStatus, before, after: snapshot(final) } as unknown as Prisma.InputJsonValue,
      });
    }
    return { changes };
  },

  // Flagged tenants first; `onlyFlagged` for the hourly run, every tenant
  // with a subscription for the daily one. One tenant's failure (Paystack
  // unreachable for it) never stops the rest; it stays flagged.
  syncMany: async (options: { onlyFlagged: boolean; tenantIds?: string[]; now?: Date }): Promise<{ checked: number; corrected: number; failed: number }> => {
    const tenants = await subscriptionRepository.findForSync({ onlyFlagged: options.onlyFlagged, limit: 500, ...(options.tenantIds && { tenantIds: options.tenantIds }) });
    let corrected = 0;
    let failed = 0;
    for (const tenant of tenants) {
      try {
        const { changes } = await subscriptionSyncService.syncTenant(tenant, options.now);
        if (changes.length > 0) corrected++;
      } catch (err) {
        failed++;
        console.error(`[subscription sync] tenant ${tenant.id} could not be synced:`, err);
      }
    }
    return { checked: tenants.length, corrected, failed };
  },
};
