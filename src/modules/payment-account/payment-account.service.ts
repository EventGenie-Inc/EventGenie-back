import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError } from '../../shared/payments/paystack.client.js';
import { paymentAccountRepository } from './payment-account.repository.js';
import { type SubmitSubaccountDto, type UpdateSubaccountDto, type SubaccountStatusDto } from './payment-account.types.js';

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
// Shared by getStatus/submit/update — every one of them ends with "a
// tenant's current subaccount status, projected for the browser".
// Built as an explicit allowlist against saveSubaccount's own select
// (not a spread), for the same reason that select exists: whatever
// Prisma call produced this object, only these fields are safe to send
// back, and a Tenant field added later must never leak into this DTO
// by accident.
const toStatusDto = (tenant: {
  paystackSubaccountStatus: SubaccountStatusDto['status'];
  paystackSubaccountCode: string | null;
  paystackBusinessName: string | null;
  paystackSettlementBankName: string | null;
  paystackAccountNumberLast4: string | null;
  paystackAccountHolderName: string | null;
  paystackSubaccountFailureReason: string | null;
}): SubaccountStatusDto => ({
  status: tenant.paystackSubaccountStatus,
  readyToSell: tenant.paystackSubaccountStatus === 'ACTIVE',
  subaccountCode: tenant.paystackSubaccountCode,
  businessName: tenant.paystackBusinessName,
  bankName: tenant.paystackSettlementBankName,
  accountNumberLast4: tenant.paystackAccountNumberLast4,
  // Legacy entries predate the distinct field. businessName is a
  // useful fallback for those records, but new submissions retain
  // the organiser-entered holder name separately.
  accountHolderName: tenant.paystackAccountHolderName ?? tenant.paystackBusinessName,
  failureReason: tenant.paystackSubaccountFailureReason,
});

export const paymentAccountService = {
  getStatus: async (tenantId: string): Promise<SubaccountStatusDto> => {
    let tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    // The Paystack create/update response contains the account number,
    // so new entries always populate last-four locally. For a pre-column
    // subaccount, make one read to Paystack and cache only its final four
    // digits. A provider outage must not turn a tenant's existing status
    // page into a 500, so retain the known local status in that case.
    if (tenant.paystackSubaccountCode && !tenant.paystackAccountNumberLast4) {
      try {
        const live = await paystackClient.getSubaccount(tenant.paystackSubaccountCode);
        await paymentAccountRepository.cacheVisibleDetails(tenantId, {
          businessName: live.businessName,
          settlementBankName: live.settlementBank,
          accountNumberLast4: live.accountNumber.slice(-4),
        });
        tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
        if (!tenant) throw new HttpError(404, 'Tenant not found');
      } catch (err) {
        // The cached metadata below is still safe to return. It is
        // better to show "not available yet" than to conceal the full
        // account status just because Paystack is temporarily
        // unreachable — but that's a decision to keep serving, not a
        // reason to keep it invisible: this used to be a bare `catch {}`
        // with nothing logged at all.
        console.error(`[payment-account] legacy last-4 backfill failed — tenant ${tenantId}:`, err);
      }
    }
    // `tenant` can only become null in the defensive re-read above if a
    // concurrent archive/removal occurred; keep the public contract a
    // normal 404 rather than dereferencing a nullable row.
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    return toStatusDto(tenant);
  },

  listBanks: () => paystackClient.listBanks(),

  submit: async (tenantId: string, data: SubmitSubaccountDto): Promise<SubaccountStatusDto> => {
    const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

    if (tenant.paystackSubaccountCode) {
      throw new HttpError(
        409,
        'A payout account has already been submitted for this tenant. Use the update endpoint to change it.'
      );
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
    } catch (err) {
      if (err instanceof PaystackApiError) {
        console.error(`[payment-account] subaccount submission failed — tenant ${tenantId}:`, err);
        await paymentAccountRepository.markFailed(tenantId, err.paystackMessage);
        // 422 — the shape of the request was valid, but Paystack's own
        // verification of the bank details failed a precondition. The
        // real reason ("account number does not match the bank") is
        // Paystack's own message, surfaced verbatim rather than
        // replaced with a generic string. (Tenant.paystackSubaccountFailureReason
        // is a self-service status field for the tenant's own onboarding
        // UI, not the payment ledger — a clean human message is the
        // correct content for it, unlike a PaymentLedgerEntry.payload.)
        throw new HttpError(422, err.paystackMessage);
      }
      throw err;
    }

    const saved = await paymentAccountRepository.saveSubaccount(tenantId, {
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
      accountNumberLast4: result.accountNumber.slice(-4),
      ...(data.accountHolderName !== undefined && { accountHolderName: data.accountHolderName }),
    });
    return toStatusDto(saved);
  },

  update: async (tenantId: string, data: UpdateSubaccountDto): Promise<SubaccountStatusDto> => {
    const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, 'Tenant not found');

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
    } catch (err) {
      if (err instanceof PaystackApiError) {
        console.error(`[payment-account] subaccount update failed — tenant ${tenantId}:`, err);
        await paymentAccountRepository.markFailed(tenantId, err.paystackMessage);
        throw new HttpError(422, err.paystackMessage);
      }
      throw err;
    }

    const saved = await paymentAccountRepository.saveSubaccount(tenantId, {
      subaccountCode: result.subaccountCode,
      status: result.active ? 'ACTIVE' : 'PENDING',
      businessName: result.businessName,
      settlementBankCode: data.settlementBank ?? tenant.paystackSettlementBankCode,
      settlementBankName: result.settlementBank,
      accountNumberLast4: data.accountNumber ? result.accountNumber.slice(-4) : tenant.paystackAccountNumberLast4,
      ...(data.accountHolderName !== undefined && { accountHolderName: data.accountHolderName }),
    });
    return toStatusDto(saved);
  },
};
