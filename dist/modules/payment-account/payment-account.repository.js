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
            paystackSubaccountCode: true,
            paystackSubaccountStatus: true,
            paystackBusinessName: true,
            paystackSettlementBankCode: true,
            paystackSettlementBankName: true,
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
            paystackSubaccountFailureReason: null,
        },
    }),
    markFailed: (tenantId, reason) => prisma.tenant.update({
        where: { id: tenantId },
        data: {
            paystackSubaccountStatus: 'FAILED',
            paystackSubaccountFailureReason: reason,
        },
    }),
};
//# sourceMappingURL=payment-account.repository.js.map