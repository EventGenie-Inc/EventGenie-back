import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
export const paymentAccountRepository = {
    // Accepts an optional transaction client so
    // payment-account-readiness.util.ts's guard can run inside
    // rsvp.service.ts's existing submit() transaction (a plain read, no
    // external call, so there's no reason to pay for a second round trip
    // outside it).
    findStatusByTenantId: (tenantId, db = prisma) => db.tenant.findFirst({
        where: { id: tenantId },
        select: {
            id: true,
            // Selected alongside the subaccount fields (not a separate
            // query) purely because payment-account-readiness.util.ts's
            // combined "can this tenant sell tickets" guard needs both —
            // this repository's own getStatus()/submit()/update() callers
            // simply ignore the extra field.
            subscriptionTier: true,
            // Selected so payment-account-readiness.util.ts's event-
            // creation-time guard can compute the tenant's EFFECTIVE tier
            // (Subscription Billing batch) rather than the raw stored one —
            // see effective-tier.util.ts.
            subscriptionCancelAtPeriodEnd: true,
            subscriptionCurrentPeriodEnd: true,
            subscriptionGraceStartedAt: true,
            paystackSubaccountCode: true,
            paystackSubaccountStatus: true,
            paystackBusinessName: true,
            paystackSettlementBankCode: true,
            paystackSettlementBankName: true,
            paystackAccountNumberLast4: true,
            paystackAccountHolderName: true,
            paystackSubaccountFailureReason: true,
        },
    }),
    // Used for both the initial submit and every subsequent update —
    // Paystack's response is the source of truth for status/businessName/
    // bankName after either call, so both paths write through the same
    // method. Clears any previous failure reason: a successful save means
    // whatever failed before no longer applies.
    saveSubaccount: (tenantId, data) => prisma.tenant.update({
        where: { id: tenantId },
        data: {
            paystackSubaccountCode: data.subaccountCode,
            paystackSubaccountStatus: data.status,
            paystackBusinessName: data.businessName,
            paystackSettlementBankCode: data.settlementBankCode,
            paystackSettlementBankName: data.settlementBankName,
            paystackAccountNumberLast4: data.accountNumberLast4,
            ...(data.accountHolderName !== undefined && { paystackAccountHolderName: data.accountHolderName }),
            paystackSubaccountFailureReason: null,
        },
        // Explicit select — without one, Prisma's update() returns the
        // FULL updated row, and this is a live leak: paymentAccountService's
        // submit()/update() hand this straight back to the router as the
        // response body. The unselected row includes paystackAuthorizationCode
        // (a live Paystack charging credential, entirely unrelated to this
        // module — see Tenant's schema comment on the two separate Paystack
        // surfaces) and every other subscription-billing column. Same
        // fields as findStatusByTenantId's own select, minus the two
        // subscription-tier columns that select carries only for
        // payment-account-readiness.util.ts's internal use.
        select: {
            paystackSubaccountCode: true,
            paystackSubaccountStatus: true,
            paystackBusinessName: true,
            paystackSettlementBankName: true,
            paystackAccountNumberLast4: true,
            paystackAccountHolderName: true,
            paystackSubaccountFailureReason: true,
        },
    }),
    markFailed: (tenantId, reason) => prisma.tenant.update({
        where: { id: tenantId },
        data: {
            paystackSubaccountStatus: 'FAILED',
            paystackSubaccountFailureReason: reason,
        },
    }),
    cacheVisibleDetails: (tenantId, data) => prisma.tenant.update({
        where: { id: tenantId },
        data: {
            paystackBusinessName: data.businessName,
            paystackSettlementBankName: data.settlementBankName,
            paystackAccountNumberLast4: data.accountNumberLast4,
        },
    }),
};
//# sourceMappingURL=payment-account.repository.js.map