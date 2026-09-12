import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError } from '../../shared/payments/paystack.client.js';
import { paymentAccountRepository } from './payment-account.repository.js';
import {} from './payment-account.types.js';
// ─────────────────────────────────────────
//  PAYMENT ACCOUNT SERVICE
//
//  Tenant-scoped self-service onboarding of the Paystack subaccount
//  that a tenant's ticket sales split into — entirely separate from
//  anything subscription/card-related (see Tenant's schema comment).
//  Every method here takes tenantId straight from the authenticated
//  caller's own JWT (payment-account.router.ts), never a route param —
//  there is no cross-tenant surface to guard because a tenant admin can
//  only ever act on their own tenant's payout account.
// ─────────────────────────────────────────
export const paymentAccountService = {
    getStatus: async (tenantId) => {
        const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        return {
            status: tenant.paystackSubaccountStatus,
            readyToSell: tenant.paystackSubaccountStatus === 'ACTIVE',
            subaccountCode: tenant.paystackSubaccountCode,
            businessName: tenant.paystackBusinessName,
            bankName: tenant.paystackSettlementBankName,
            failureReason: tenant.paystackSubaccountFailureReason,
        };
    },
    listBanks: () => paystackClient.listBanks(),
    submit: async (tenantId, data) => {
        const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        if (tenant.paystackSubaccountCode) {
            throw new HttpError(409, 'A payout account has already been submitted for this tenant. Use the update endpoint to change it.');
        }
        let result;
        try {
            result = await paystackClient.createSubaccount({
                businessName: data.businessName,
                settlementBank: data.settlementBank,
                accountNumber: data.accountNumber,
                // The subaccount's own default split stays at 0% (subaccount
                // keeps 100% by default) — per-ticket commission routing is a
                // per-transaction concern for ticketing to implement later, not
                // a fixed split baked into the subaccount itself.
                percentageCharge: 0,
                ...(data.primaryContactEmail !== undefined && { primaryContactEmail: data.primaryContactEmail }),
                ...(data.primaryContactName !== undefined && { primaryContactName: data.primaryContactName }),
                ...(data.primaryContactPhone !== undefined && { primaryContactPhone: data.primaryContactPhone }),
            });
        }
        catch (err) {
            if (err instanceof PaystackApiError) {
                await paymentAccountRepository.markFailed(tenantId, err.paystackMessage);
                // 422 — the shape of the request was valid, but Paystack's own
                // verification of the bank details failed a precondition. The
                // real reason ("account number does not match the bank") is
                // Paystack's own message, surfaced verbatim rather than
                // replaced with a generic string.
                throw new HttpError(422, err.paystackMessage);
            }
            throw err;
        }
        return paymentAccountRepository.saveSubaccount(tenantId, {
            subaccountCode: result.subaccountCode,
            // PENDING vs ACTIVE is read directly off Paystack's own `active`
            // flag on the created subaccount, not guessed.
            status: result.active ? 'ACTIVE' : 'PENDING',
            businessName: result.businessName,
            settlementBankCode: data.settlementBank,
            // Paystack echoes back its own resolved bank field on the
            // subaccount object — stored as-is rather than re-deriving it
            // from a second listBanks() lookup.
            settlementBankName: result.settlementBank,
        });
    },
    update: async (tenantId, data) => {
        const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
        if (!tenant)
            throw new HttpError(404, 'Tenant not found');
        if (!tenant.paystackSubaccountCode) {
            throw new HttpError(422, 'No payout account has been submitted yet for this tenant. Submit your details first.');
        }
        let result;
        try {
            result = await paystackClient.updateSubaccount(tenant.paystackSubaccountCode, {
                ...(data.businessName !== undefined && { businessName: data.businessName }),
                ...(data.settlementBank !== undefined && { settlementBank: data.settlementBank }),
                ...(data.accountNumber !== undefined && { accountNumber: data.accountNumber }),
                ...(data.primaryContactEmail !== undefined && { primaryContactEmail: data.primaryContactEmail }),
                ...(data.primaryContactName !== undefined && { primaryContactName: data.primaryContactName }),
                ...(data.primaryContactPhone !== undefined && { primaryContactPhone: data.primaryContactPhone }),
            });
        }
        catch (err) {
            if (err instanceof PaystackApiError) {
                await paymentAccountRepository.markFailed(tenantId, err.paystackMessage);
                throw new HttpError(422, err.paystackMessage);
            }
            throw err;
        }
        return paymentAccountRepository.saveSubaccount(tenantId, {
            subaccountCode: result.subaccountCode,
            status: result.active ? 'ACTIVE' : 'PENDING',
            businessName: result.businessName,
            settlementBankCode: data.settlementBank ?? tenant.paystackSettlementBankCode,
            settlementBankName: result.settlementBank,
        });
    },
};
//# sourceMappingURL=payment-account.service.js.map