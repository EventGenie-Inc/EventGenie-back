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
  subscriptionPendingAuthorizationUrl: true,
  subscriptionPendingStartedAt: true,
  subscriptionNeedsSync: true,
  subscriptionLastSyncedAt: true,
  // Custom tiers: the plan shown by getStatus may be a custom tier.
  customTierId: true,
  customTierEndsAt: true,
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
  //
  // Compared in normal form on BOTH sides (trimmed, lowercased — see
  // shared/utils/email.util.ts): Paystack echoes the address in whatever
  // case it holds, and a stored row the lowercase_tenant_emails migration
  // had to skip (a collision) may still be mixed-case. The caller passes
  // the address already normalised. (\\s is doubled because this is a JS
  // template literal: a single \s would reach Postgres as a plain "s".)
  // Two stored rows that normalise to the
  // same address make the match ambiguous, so neither is returned: crediting
  // the wrong tenant with a subscription is worse than leaving the webhook
  // unclaimed (it's logged; resolve the collision with
  // scripts/report-email-collisions.ts).
  findByEmail: async (normalizedEmail: string, db: Db = prisma) => {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Tenant"
      WHERE lower(regexp_replace("email", '^\\s+|\\s+$', '', 'g')) = ${normalizedEmail}
      LIMIT 2`;
    if (rows.length !== 1) {
      if (rows.length > 1) {
        console.error('[subscription] two tenants share a billing email once normalised — not matching either; see scripts/report-email-collisions.ts');
      }
      return null;
    }
    return db.tenant.findFirst({ where: { id: (rows[0] as { id: string }).id }, select: SUBSCRIPTION_FIELDS });
  },

  // The tenant's own in-flight subscribe attempt — set by
  // savePendingAttempt before the Initialize Transaction call, matched
  // by OUR chosen reference, exactly mirroring TicketPurchase.paymentRef.
  findByPendingReference: (reference: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { subscriptionPendingReference: reference }, select: SUBSCRIPTION_FIELDS }),

  // Payments release 1: the pending attempt is CLAIMED, not overwritten. It
  // takes only when no attempt is pending or the pending one is older than
  // the reuse window (pending-checkout.util.ts), in one conditional UPDATE,
  // so two clicks can't both start a checkout. false: an attempt is already
  // pending; the caller reads it and reuses its link or refuses.
  claimPendingAttempt: async (
    tenantId: string,
    data: { reference: string; tier: SubscriptionTier; period: SubscriptionPeriod },
    reuseCutoff: Date,
    db: Db = prisma
  ): Promise<boolean> => {
    const result = await db.tenant.updateMany({
      where: {
        id: tenantId,
        OR: [
          { subscriptionPendingReference: null },
          { subscriptionPendingStartedAt: null },
          { subscriptionPendingStartedAt: { lt: reuseCutoff } },
        ],
      },
      data: {
        subscriptionPendingReference: data.reference,
        subscriptionPendingTier: data.tier,
        subscriptionPendingPeriod: data.period,
        subscriptionPendingStartedAt: new Date(),
        subscriptionPendingAuthorizationUrl: null,
      },
    });
    return result.count === 1;
  },

  savePendingAuthorizationUrl: (tenantId: string, reference: string, authorizationUrl: string, db: Db = prisma) =>
    db.tenant.updateMany({
      where: { id: tenantId, subscriptionPendingReference: reference },
      data: { subscriptionPendingAuthorizationUrl: authorizationUrl },
    }),

  // Clears the pending attempt. With a reference, only if it is still that
  // attempt (a newer one is left alone).
  clearPendingAttempt: (tenantId: string, db: Db = prisma, reference?: string) =>
    db.tenant.updateMany({
      where: { id: tenantId, ...(reference !== undefined && { subscriptionPendingReference: reference }) },
      data: {
        subscriptionPendingReference: null,
        subscriptionPendingTier: null,
        subscriptionPendingPeriod: null,
        subscriptionPendingAuthorizationUrl: null,
        subscriptionPendingStartedAt: null,
      },
    }),

  findBySubscriptionCode: (subscriptionCode: string, db: Db = prisma) =>
    db.tenant.findFirst({ where: { paystackSubscriptionCode: subscriptionCode }, select: SUBSCRIPTION_FIELDS }),

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
        subscriptionPendingAuthorizationUrl: null,
        subscriptionPendingStartedAt: null,
        subscriptionNeedsSync: false,
        subscriptionLastSyncedAt: new Date(),
        // A paid subscription takes the tenant off any custom tier: what
        // they now pay for is their plan (a trial converting, say).
        customTierId: null,
        customTierEndsAt: null,
        customTierAssignedAt: null,
        customTierEndingNoticeSentAt: null,
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
  // Also marks the tenant in step with Paystack (payments release 1).
  updateCurrentPeriodEnd: (tenantId: string, currentPeriodEnd: Date, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: { subscriptionCurrentPeriodEnd: currentPeriodEnd, subscriptionNeedsSync: false, subscriptionLastSyncedAt: new Date() },
    }),

  // ── Payments release 1 ──

  markNeedsSync: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({ where: { id: tenantId }, data: { subscriptionNeedsSync: true } }),

  markSynced: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({ where: { id: tenantId }, data: { subscriptionNeedsSync: false, subscriptionLastSyncedAt: new Date() } }),

  clearGrace: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({ where: { id: tenantId }, data: { subscriptionGraceStartedAt: null } }),

  setCancelAtPeriodEnd: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({ where: { id: tenantId }, data: { subscriptionCancelAtPeriodEnd: true } }),

  // A refunded (or charged-back) subscription: access ends now. The tenant
  // is on Spark at once; everything it made is kept. Its Paystack codes are
  // kept until the subscription is disabled at Paystack (post-commit, or
  // the sync: subscriptionNeedsSync), then cleared by clearSubscriptionCodes.
  endSubscriptionNow: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionTier: 'SPARK',
        subscriptionPeriod: null,
        subscriptionCurrentPeriodEnd: null,
        subscriptionCancelAtPeriodEnd: false,
        subscriptionPendingTierAfterPeriodEnd: null,
        subscriptionGraceStartedAt: null,
        subscriptionNeedsSync: true,
      },
    }),

  // The tenant's row, locked until the transaction ends: a decision on its
  // billing state, then the write, without another writer in between.
  lockTenant: (tenantId: string, tx: Prisma.TransactionClient) =>
    tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`,

  // On Spark with no live subscription (subscription-state.util.ts's
  // needsSettlingOnSpark decides): every field that described one cleared,
  // the cancelling and pending-downgrade markers and the stale subscription
  // code included. The customer code and saved card stay (a later charge is
  // still matched by them); a pending checkout stays (the tenant's own next
  // purchase).
  settleOnSpark: (tenantId: string, db: Db = prisma) =>
    db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionTier: 'SPARK',
        subscriptionPeriod: null,
        subscriptionCurrentPeriodEnd: null,
        subscriptionCancelAtPeriodEnd: false,
        subscriptionPendingTierAfterPeriodEnd: null,
        subscriptionGraceStartedAt: null,
        paystackSubscriptionCode: null,
        paystackSubscriptionEmailToken: null,
      },
    }),

  // Tenants that may need settling (the hourly sweep): anything but a clean
  // Spark row or a paid one inside its period. needsSettlingOnSpark makes
  // the decision; this only narrows the list.
  findSettleCandidates: (now: Date, limit: number, tenantIds?: string[]) =>
    prisma.tenant.findMany({
      where: {
        ...(tenantIds && { id: { in: tenantIds } }),
        OR: [
          { subscriptionCancelAtPeriodEnd: true },
          { subscriptionPendingTierAfterPeriodEnd: { not: null } },
          { subscriptionGraceStartedAt: { not: null } },
          { subscriptionCurrentPeriodEnd: { lte: now } },
          { subscriptionTier: { not: 'SPARK' }, paystackSubscriptionCode: null },
          {
            subscriptionTier: 'SPARK',
            OR: [{ subscriptionPeriod: { not: null } }, { subscriptionCurrentPeriodEnd: { not: null } }, { paystackSubscriptionCode: { not: null } }],
          },
        ],
      },
      select: SUBSCRIPTION_FIELDS,
      take: limit,
    }),

  // After the subscription has been disabled at Paystack.
  clearSubscriptionCodes: (tenantId: string, subscriptionCode: string, db: Db = prisma) =>
    db.tenant.updateMany({
      where: { id: tenantId, paystackSubscriptionCode: subscriptionCode },
      data: {
        paystackSubscriptionCode: null,
        paystackSubscriptionEmailToken: null,
        subscriptionNeedsSync: false,
        subscriptionLastSyncedAt: new Date(),
      },
    }),

  // The sync's work list: tenants flagged first, then (full run) every
  // tenant holding a Paystack subscription. tenantIds scopes a test's run to
  // its own tenants.
  findForSync: (options: { onlyFlagged: boolean; tenantIds?: string[]; limit: number }) =>
    prisma.tenant.findMany({
      where: {
        ...(options.tenantIds && { id: { in: options.tenantIds } }),
        ...(options.onlyFlagged
          ? { subscriptionNeedsSync: true }
          : { OR: [{ subscriptionNeedsSync: true }, { paystackSubscriptionCode: { not: null } }] }),
      },
      select: SUBSCRIPTION_FIELDS,
      orderBy: [{ subscriptionNeedsSync: 'desc' }, { subscriptionLastSyncedAt: { sort: 'asc', nulls: 'first' } }],
      take: options.limit,
    }),

  findStalePendingAttempts: (before: Date, tenantIds?: string[]) =>
    prisma.tenant.findMany({
      where: {
        subscriptionPendingReference: { not: null },
        OR: [{ subscriptionPendingStartedAt: null }, { subscriptionPendingStartedAt: { lt: before } }],
        ...(tenantIds && { id: { in: tenantIds } }),
      },
      select: SUBSCRIPTION_FIELDS,
      take: 200,
    }),

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
