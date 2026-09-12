import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { paymentAccountRepository } from './payment-account.repository.js';
// ─────────────────────────────────────────
//  Guard used by event.service.ts's create/update/publish AND
//  ticket-purchase.service.ts's reserve step — a paid event cannot
//  exist, and a ticket cannot be sold, unless (a) the tenant's plan
//  permits ticketing at all (SPARK doesn't — existing tier rule,
//  re-checked here as defense in depth since this is a NEW path that
//  moves real money) and (b) there is somewhere for the split to land.
//
//  Checked at event create/update time (ticketing being set to PAID),
//  again at publish time, and again at purchase-initiation time — a
//  tenant's subaccount can regress from ACTIVE to FAILED after an event
//  was already created as PAID (a bad bank-detail update attempt — see
//  payment-account.service.ts's update, which calls markFailed on a
//  rejected Paystack update even when a previous submission had
//  succeeded), and a tenant's plan can be downgraded to SPARK after a
//  PAID event already exists.
// ─────────────────────────────────────────
export const assertTenantReadyToSellTickets = async (tenantId, db = prisma) => {
    const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId, db);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    if (tenant.subscriptionTier === 'SPARK') {
        throw new HttpError(403, 'The SPARK plan does not support paid ticketing. Upgrade to CELEBRATE or ELEVATE to sell tickets.');
    }
    if (tenant.paystackSubaccountStatus !== 'ACTIVE' || !tenant.paystackSubaccountCode) {
        throw new HttpError(422, 'Paid ticketing needs an active payout account before it can be used. Add your bank details under payment settings first.');
    }
    return { subaccountCode: tenant.paystackSubaccountCode };
};
//# sourceMappingURL=payment-account-readiness.util.js.map