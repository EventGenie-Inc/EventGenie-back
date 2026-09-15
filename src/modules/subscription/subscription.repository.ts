import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';
import { type ActivateSubscriptionInput } from './subscription.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// Every read below selects the full set of subscription-billing
// columns — this module is the one place that legitimately needs all
// of them together (unlike, say, payment-account.repository.ts, which
// only needs a couple alongside its own subaccount fields).
const SUBSCRIPTION_FIELDS = {
  id: true,
  email: true,
  subscriptionTier: true,
  subscriptionPeriod: true,
  subscriptionCurrentPeriodEnd: true,
  subscriptionCancelAtPeriodEnd: true,
  subscriptionPendingTierAfterPeriodEnd: true,
  subscriptionGraceStartedAt: true,
  paystackCustomerCode: true,
  paystackSubscriptionCode: true,
  paystackSubscriptionEmailToken: true,
  paystackAuthorizationCode: true,
  paystackCardBrand: true,
  paystackCardLast4: true,
  paystackCardExpMonth: true,
  paystackCardExpYear: true,
  subscriptionPendingReference: true,
  subscriptionPendingTier: true,
  subscriptionPendingPeriod: true,
} as const;

export const subscriptionRepository = {
  findBillingStateByTenantId: (tenantId: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { id: tenantId }, select: SUBSCRIPTION_FIELDS }),

  // Renewal / upgrade charges carry no reference we chose — this is how
  // they're matched back to a tenant. @unique on the column.
  findByCustomerCode: (customerCode: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { paystackCustomerCode: customerCode }, select: SUBSCRIPTION_FIELDS }),

  // subscription.create/disable carry no reference either — matched by
  // the tenant's own (unique) billing email instead. Order-independent
  // of charge.success, unlike matching by customer_code (see
  // subscription.service.ts's dispatch comment).
  findByEmail: (email: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { email }, select: SUBSCRIPTION_FIELDS }),

  // The tenant's own in-flight subscribe attempt — set by
  // savePendingAttempt before the Initialize Transaction call, matched
  // by OUR chosen reference, exactly mirroring TicketPurchase.paymentRef.
  findByPendingReference: (reference: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { subscriptionPendingReference: reference }, select: SUBSCRIPTION_FIELDS }),

  savePendingAttempt: (
    tenantId: string,
    data: { reference: string; tier: SubscriptionTier; period: SubscriptionPeriod },
    db: Db = prisma
  ) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionPendingReference: data.reference,
        subscriptionPendingTier: data.tier,
        subscriptionPendingPeriod: data.period,
      },
    }),

  clearPendingAttempt: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionPendingReference: null,
        subscriptionPendingTier: null,
        subscriptionPendingPeriod: null,
      },
    }),

  // Records that a charge succeeded WITHOUT necessarily flipping tier —
  // used for the initial-subscribe charge.success (tier flip waits for
  // subscription.create, which carries the authoritative subscription
  // code/email_token/next_payment_date) and to keep card display
  // details fresh on every charge. Clears grace unconditionally: any
  // successful charge proves the tenant is paying again right now.
  recordChargeSucceededPreliminary: (
    tenantId: string,
    data: { customerCode: string; authorizationCode?: string; cardBrand?: string; cardLast4?: string; cardExpMonth?: string; cardExpYear?: string },
    db: Db = prisma
  ) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        paystackCustomerCode: data.customerCode,
        subscriptionGraceStartedAt: null,
        ...(data.authorizationCode !== undefined && { paystackAuthorizationCode: data.authorizationCode }),
        ...(data.cardBrand !== undefined && { paystackCardBrand: data.cardBrand }),
        ...(data.cardLast4 !== undefined && { paystackCardLast4: data.cardLast4 }),
        ...(data.cardExpMonth !== undefined && { paystackCardExpMonth: data.cardExpMonth }),
        ...(data.cardExpYear !== undefined && { paystackCardExpYear: data.cardExpYear }),
      },
    }),

  // The one true "tenant is now confirmed on this plan" write —
  // activates the tier/period, stores Paystack's own identifiers, and
  // clears any prior cancel/grace state (a fresh successful
  // subscription supersedes whatever came before it).
  activateSubscription: (tenantId: string, data: ActivateSubscriptionInput, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionTier: data.tier,
        subscriptionPeriod: data.period,
        subscriptionCurrentPeriodEnd: data.currentPeriodEnd,
        subscriptionCancelAtPeriodEnd: false,
        subscriptionPendingTierAfterPeriodEnd: null,
        subscriptionGraceStartedAt: null,
        paystackCustomerCode: data.customerCode,
        paystackSubscriptionCode: data.subscriptionCode,
        paystackSubscriptionEmailToken: data.emailToken,
        subscriptionPendingReference: null,
        subscriptionPendingTier: null,
        subscriptionPendingPeriod: null,
        ...(data.authorizationCode !== undefined && { paystackAuthorizationCode: data.authorizationCode }),
        ...(data.cardBrand !== undefined && { paystackCardBrand: data.cardBrand }),
        ...(data.cardLast4 !== undefined && { paystackCardLast4: data.cardLast4 }),
        ...(data.cardExpMonth !== undefined && { paystackCardExpMonth: data.cardExpMonth }),
        ...(data.cardExpYear !== undefined && { paystackCardExpYear: data.cardExpYear }),
      },
    }),

  // Just refreshes the renewal date on an ongoing subscription — no
  // tier/period change, no clearing of cancel/pending fields (a renewal
  // that succeeds on a subscription already scheduled to cancel at
  // period end should NOT happen — Paystack was told to disable it —
  // but if it somehow did, leaving cancelAtPeriodEnd alone is the safe
  // choice: it still stands for whatever the NEXT period end is now).
  updateCurrentPeriodEnd: (tenantId: string, currentPeriodEnd: Date, db: Db = prisma) =>
    db.tenant.update({ where: { id: tenantId }, data: { subscriptionCurrentPeriodEnd: currentPeriodEnd } }),

  // First failure starts the grace clock; a SECOND failure while
  // already in (or past) grace must NOT push the deadline forward — see
  // effective-tier.util.ts's comment on why extending it would let a
  // permanently-broken card ride a rolling grace period forever. Raw
  // SQL is what makes "only if not already set" atomic — a read-then-
  // write from the service layer would race two closely-timed failure
  // webhooks for the same tenant (unlikely for one tenant, but the
  // point of this whole file is not to rely on "unlikely").
  recordChargeFailureIfFirst: (tenantId: string, db: Db = prisma) =>
    db.$executeRaw`
      UPDATE "Tenant"
      SET "subscriptionGraceStartedAt" = COALESCE("subscriptionGraceStartedAt", now())
      WHERE id = ${tenantId}
    `,

  // Cancellation and "downgrade to a different paid tier" share this
  // exact mechanism — see effective-tier.util.ts's own comment on why a
  // downgrade cannot safely auto-create the new paid subscription at
  // the period boundary. pendingTier is null for a full cancel (falls
  // to SPARK), or the target tier for display purposes on a downgrade.
  scheduleEndOfPeriodChange: (tenantId: string, pendingTier: SubscriptionTier | null, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionCancelAtPeriodEnd: true,
        subscriptionPendingTierAfterPeriodEnd: pendingTier,
      },
    }),
};
