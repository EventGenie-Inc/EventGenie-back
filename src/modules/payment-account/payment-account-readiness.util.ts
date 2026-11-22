import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { paymentAccountRepository } from './payment-account.repository.js';
import { resolveEventPlan, resolveTenantPlan } from '../subscription-tier-config/effective-plan.util.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { paidTicketingRefusal } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { ORGANISATION_NOT_FOUND_MESSAGE } from '../../shared/payments/payment-errors.util.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  A tenant-level check that (a) the tenant's CURRENT EFFECTIVE plan
//  permits paid ticketing (paidTicketingEnabled) and (b) there is an active
//  payout account for the split to land in.
//
//  Since ticket sales Round A (2026-11) no event is CREATED paid (only the
//  paid switch, ticket-sales.service.ts, makes one paid), so event.service.ts
//  no longer calls this; it stays for its tests and any tenant-level check.
//  A payout account no longer regresses to FAILED on a refused change (a
//  change makes a new subaccount and leaves the current one alone,
//  payment-account.service.ts); a tenant's effective tier can still lapse to
//  SPARK after a paid event exists, which is why publish re-checks
//  (assertEventReadyToSellTickets, below).
//
//  Deliberately NOT used to gate an actual ticket PURCHASE on an
//  already-published event — see assertSubaccountReadyForPurchase
//  below for that one, and why it's a different, narrower check.
// ─────────────────────────────────────────
export const assertTenantReadyToSellTickets = async (tenantId: string, db: Db = prisma): Promise<{ subaccountCode: string }> => {
  const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId, db);
  if (!tenant) throw new HttpError(404, ORGANISATION_NOT_FOUND_MESSAGE);

  const plan = await resolveTenantPlan(tenant);
  if (!plan.values.paidTicketingEnabled) {
    throw new HttpError(403, paidTicketingRefusal(plan));
  }

  if (tenant.paystackSubaccountStatus !== 'ACTIVE' || !tenant.paystackSubaccountCode) {
    throw new HttpError(
      422,
      'Paid ticketing needs an active payout account before it can be used. Add your bank details under payment settings first.'
    );
  }

  return { subaccountCode: tenant.paystackSubaccountCode };
};

// ─────────────────────────────────────────
//  EVENT-SCOPED sibling of assertTenantReadyToSellTickets, above —
//  used by event.service.ts's update()/publish(), where the event
//  already EXISTS and may hold an active Event Pass. assertTenantReady-
//  ToSellTickets itself stays exactly as it was and keeps its ONE
//  remaining call site (event.service.ts's create()): a brand-new event
//  cannot yet have a pass, so that moment is genuinely tenant-only, the
//  same reasoning event-tier-enforcement.util.ts's assertEventCreatable/
//  assertEventUpdatable split already established.
//
//  Takes the full fetched event (not a bare tenantId) so entitlement can
//  be resolved via resolveEventEntitlement — the greater of the
//  tenant's own effective tier and the event's pass — rather than
//  resolveEffectiveTier alone. Subaccount readiness itself is left
//  UNCONDITIONAL either way: a payout destination is a fact about the
//  TENANT's bank details, entirely orthogonal to tier or pass.
// ─────────────────────────────────────────
export const assertEventReadyToSellTickets = async (event: EntitlementDerivableEvent, db: Db = prisma): Promise<{ subaccountCode: string }> => {
  const tenant = await paymentAccountRepository.findStatusByTenantId(event.tenantId, db);
  if (!tenant) throw new HttpError(404, ORGANISATION_NOT_FOUND_MESSAGE);

  const plan = await resolveEventPlan(tenant, event);
  if (!plan.values.paidTicketingEnabled) {
    throw new HttpError(403, paidTicketingRefusal(plan, true));
  }

  if (tenant.paystackSubaccountStatus !== 'ACTIVE' || !tenant.paystackSubaccountCode) {
    throw new HttpError(
      422,
      'Paid ticketing needs an active payout account before it can be used. Add your bank details under payment settings first.'
    );
  }

  return { subaccountCode: tenant.paystackSubaccountCode };
};

// ─────────────────────────────────────────
//  Guard used by ticket-purchase.service.ts's reserve/retry steps —
//  i.e. an actual guest buying a ticket on an event that is ALREADY
//  published and already selling.
//
//  ACCESS-TIME. Deliberately does NOT check the tenant's tier at all —
//  only that a subaccount still exists to receive the split, which is
//  a physical requirement for the Paystack call to succeed, not a
//  billing-tier capability. Subscription Billing batch: without this
//  split, a tenant who created a PAID event while on CELEBRATE, then
//  lapsed to SPARK, would have every in-flight and future ticket sale
//  on that ALREADY-LIVE event rejected — guests mid-transaction on an
//  event they did nothing wrong to be part of. "A public event with
//  tickets sold, on a tenant that drops to Spark, keeps functioning" is
//  explicit in this batch's brief; this function is what makes that
//  true. The tenant cannot create OR PUBLISH a new PAID event while
//  lapsed (assertTenantReadyToSellTickets above still blocks that), but
//  an existing one keeps selling indefinitely — there is no time limit
//  on this exemption, by design: revoking it later would just move the
//  same "guest mid-transaction" problem to a different moment, not
//  solve it.
// ─────────────────────────────────────────
export const assertSubaccountReadyForPurchase = async (tenantId: string, db: Db = prisma): Promise<{ subaccountCode: string }> => {
  const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId, db);
  if (!tenant) throw new HttpError(404, ORGANISATION_NOT_FOUND_MESSAGE);

  if (tenant.paystackSubaccountStatus !== 'ACTIVE' || !tenant.paystackSubaccountCode) {
    throw new HttpError(
      422,
      "This event's payout account is not currently active, so ticket purchases can't be completed right now. Please contact the organiser."
    );
  }

  return { subaccountCode: tenant.paystackSubaccountCode };
};
