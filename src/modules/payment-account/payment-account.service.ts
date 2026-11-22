import crypto from 'crypto';
import { type PayoutAccountChange, type PayoutAccountChangeKind } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError, isUncertainPaystackFailure } from '../../shared/payments/paystack.client.js';
import {
  ORGANISATION_NOT_FOUND_MESSAGE,
  PAYMENT_PROVIDER_UNAVAILABLE,
} from '../../shared/payments/payment-errors.util.js';
import { isUniqueViolationOfIndex } from '../../shared/utils/prisma-error.util.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS, type AdminAuditAction } from '../admin-audit/admin-audit.types.js';
import { paymentAccountRepository, type TenantPayoutRow } from './payment-account.repository.js';
import { payoutEmails, type PayoutEmailChange } from './payment-account-emails.js';
import {
  type PayoutAccountInput,
  type PayoutSubmissionDto,
  type PendingPayoutChangeDto,
  type SubaccountStatusDto,
} from './payment-account.types.js';

// ─────────────────────────────────────────
//  PAYOUT ACCOUNT (ticket sales Round A, 2026-11; STEERING "Ticket sales")
//
//  One per organisation: the Paystack subaccount its ticket sales are split
//  into. Only Tenant Admins (payment-account.router.ts), always their own
//  organisation (the tenant comes from the session, never the request).
//
//  The CURRENT account is the tenant's paystackSubaccount* columns; sales
//  are always paid there. Setting up or changing it is a PayoutAccountChange:
//   - a new subaccount is created at Paystack, never an existing one edited,
//     so the account in use is never touched by a change;
//   - the first setup takes effect at once (no sales yet);
//   - a change takes effect 24 hours later (PAYOUT_CHANGE_DELAY_MS), with
//     an email to the organisation's admins (carrying a single-use cancel
//     link) and to e-velope's payments address, and can be cancelled until
//     then, by the link or in the app;
//   - the worker (payment-account.worker.ts) switches it at effectiveAt,
//     only once Paystack confirms the new subaccount is active: any Paystack
//     failure leaves the current account in use and is retried;
//   - a refused or failed change never marks the current account FAILED.
//  Every step writes an audit entry (AdminAuditEntry).
//
//  THE ACCOUNT NUMBER is sent to Paystack and dropped: never stored, logged
//  or returned. Only its last 4 digits are kept. Paystack failures are
//  logged by kind and status, never with Paystack's body (which could echo
//  it); Sentry masks it by key and in text (sentry-scrub.ts).
//
//  CREATION IS SAFE TO RETRY. Paystack takes no idempotency key on POST
//  /subaccount, so each change has a creationKey, written into the
//  subaccount's description. After an unclear answer (a timeout, a network
//  error, a 5xx: the subaccount may exist) every later attempt first looks
//  for a subaccount with that key and adopts it; only if there is none does
//  it create one. Attempts in the request itself (PAYOUT_CREATE_ATTEMPTS),
//  then the worker keeps looking for an hour (it can't create one itself:
//  it never has the account number), and after that the change fails and
//  the admins are asked to enter the details again.
// ─────────────────────────────────────────

export const PAYOUT_CHANGE_DELAY_MS = 24 * 60 * 60 * 1000;
// How long the worker keeps looking for a subaccount whose creation got no
// clear answer before giving the change up.
export const PAYOUT_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;
const PAYOUT_CREATE_ATTEMPTS = 2;
const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// The actor of a step nobody took by hand (the worker's).
export const PAYOUT_AUDIT_SYSTEM_ACTOR = 'system';
// The actor of a cancel by the emailed link (no sign-in).
export const PAYOUT_AUDIT_EMAIL_LINK_ACTOR = 'email-link';
const DESCRIPTION_PREFIX = 'e-velope payout';
const MAX_NAME_LENGTH = 100;

export const PAYOUT_ERROR_CODES = {
  BANK_REQUIRED: 'PAYOUT_BANK_REQUIRED',
  BANK_UNKNOWN: 'PAYOUT_BANK_UNKNOWN',
  ACCOUNT_NUMBER_INVALID: 'PAYOUT_ACCOUNT_NUMBER_INVALID',
  HOLDER_NAME_REQUIRED: 'PAYOUT_HOLDER_NAME_REQUIRED',
  NAME_TOO_LONG: 'PAYOUT_NAME_TOO_LONG',
  ACCOUNT_EXISTS: 'PAYOUT_ACCOUNT_EXISTS',
  NOT_SET_UP: 'PAYOUT_ACCOUNT_NOT_SET_UP',
  CHANGE_PENDING: 'PAYOUT_CHANGE_PENDING',
  NO_CHANGE_PENDING: 'PAYOUT_NO_CHANGE_PENDING',
  REJECTED: 'PAYOUT_ACCOUNT_REJECTED',
  CANCEL_LINK_INVALID: 'PAYOUT_CANCEL_LINK_INVALID',
  CANCEL_LINK_USED: 'PAYOUT_CANCEL_LINK_USED',
  CANCEL_LINK_EXPIRED: 'PAYOUT_CANCEL_LINK_EXPIRED',
  CHANGE_NOT_PENDING: 'PAYOUT_CHANGE_NOT_PENDING',
} as const;

const REJECTED_MESSAGE =
  "These bank details weren't accepted. Check the bank and the account number, then try again.";
const PROVIDER_UNAVAILABLE_MESSAGE =
  "We couldn't reach our payment provider to save these bank details. Nothing changed. Please try again in a few minutes.";
const CONFIRMATION_FAILED_REASON =
  "We couldn't confirm the new account with our payment provider. Enter the bank details again.";

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
const describe = (err: unknown): string =>
  err instanceof PaystackApiError ? `${err.kind} (${err.httpStatus})` : err instanceof Error ? err.name : 'unknown';

// ── The bank list: Paystack's South African banks, cached ──

let bankCache: { banks: paystackClient.PaystackBank[]; fetchedAt: number } | null = null;

// Cached for a day. If Paystack can't be reached, the last list is used for
// as long as needed; with none at all, the neutral 503.
const listBanks = async (now = Date.now()): Promise<paystackClient.PaystackBank[]> => {
  if (bankCache && now - bankCache.fetchedAt < BANK_CACHE_TTL_MS) return bankCache.banks;
  try {
    const banks = (await paystackClient.listBanks({ country: 'south africa', currency: 'ZAR' }))
      .map((b) => ({ name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name));
    bankCache = { banks, fetchedAt: now };
    return banks;
  } catch (err) {
    console.error(`[payment-account] bank list not fetched: ${describe(err)}`);
    if (bankCache) return bankCache.banks;
    throw new HttpError(503, PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
  }
};

// For tests: forget the cached list.
export const clearBankCacheForTests = (): void => {
  bankCache = null;
};

// ── The request body ──

interface ParsedAccount {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  businessName: string;
}

const text = (value: unknown, max: number, code: string, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length > max) throw new HttpError(422, `${label} can be at most ${max} characters.`, code);
  return trimmed || null;
};

const parseAccountInput = async (body: unknown): Promise<ParsedAccount> => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request body must be an object.');
  const input = body as PayoutAccountInput;

  const bankCode = typeof input.settlementBank === 'string' ? input.settlementBank.trim() : '';
  if (!bankCode) throw new HttpError(422, 'Choose your bank.', PAYOUT_ERROR_CODES.BANK_REQUIRED);

  // Digits only, spaces and hyphens ignored. South African account numbers
  // are 7 to 11 digits; 6 to 16 leaves room for any Paystack accepts.
  const accountNumber = typeof input.accountNumber === 'string' || typeof input.accountNumber === 'number'
    ? String(input.accountNumber).replace(/[\s-]/g, '')
    : '';
  if (!/^\d{6,16}$/.test(accountNumber)) {
    throw new HttpError(422, 'Enter the account number: digits only, 6 to 16 of them.', PAYOUT_ERROR_CODES.ACCOUNT_NUMBER_INVALID);
  }

  const accountHolderName = text(input.accountHolderName, MAX_NAME_LENGTH, PAYOUT_ERROR_CODES.NAME_TOO_LONG, "The account holder's name");
  if (!accountHolderName) throw new HttpError(422, "Enter the account holder's name, as the bank has it.", PAYOUT_ERROR_CODES.HOLDER_NAME_REQUIRED);
  const businessName = text(input.businessName, MAX_NAME_LENGTH, PAYOUT_ERROR_CODES.NAME_TOO_LONG, 'The business name') ?? accountHolderName;

  // Checked last: the only check that may need Paystack.
  const bank = (await listBanks()).find((b) => b.code === bankCode);
  if (!bank) throw new HttpError(422, "That bank isn't in the list. Choose your bank from the list.", PAYOUT_ERROR_CODES.BANK_UNKNOWN);

  return { bankCode, bankName: bank.name, accountNumber, accountHolderName, businessName };
};

// ── Projections ──

const toPendingDto = (change: PayoutAccountChange): PendingPayoutChangeDto => ({
  id: change.id,
  kind: change.kind,
  status: change.status as PendingPayoutChangeDto['status'],
  bankName: change.bankName,
  accountNumberLast4: change.accountNumberLast4,
  accountHolderName: change.accountHolderName,
  requestedAt: change.createdAt,
  effectiveAt: change.effectiveAt,
  creationConfirmed: change.subaccountCode !== null,
});

// An explicit allowlist: a column added to Tenant later never leaks here.
const toStatusDto = (tenant: TenantPayoutRow, open: PayoutAccountChange | null): SubaccountStatusDto => {
  const hasAccount = tenant.paystackSubaccountCode !== null;
  return {
    state: open ? (hasAccount ? 'CHANGE_PENDING' : 'SETUP_PENDING') : hasAccount ? 'ACTIVE' : 'NONE',
    status: tenant.paystackSubaccountStatus,
    readyToSell: tenant.paystackSubaccountStatus === 'ACTIVE' && hasAccount,
    subaccountCode: tenant.paystackSubaccountCode,
    businessName: tenant.paystackBusinessName,
    bankName: tenant.paystackSettlementBankName,
    accountNumberLast4: tenant.paystackAccountNumberLast4,
    // Accounts from before the holder's name was kept show the business name.
    accountHolderName: tenant.paystackAccountHolderName ?? tenant.paystackBusinessName,
    activeSince: tenant.paystackSubaccountActiveSince,
    failureReason: hasAccount ? null : tenant.paystackSubaccountFailureReason,
    pendingChange: open ? toPendingDto(open) : null,
  };
};

const emailView = (c: PayoutAccountChange): PayoutEmailChange => ({
  id: c.id,
  tenantId: c.tenantId,
  bankName: c.bankName,
  accountNumberLast4: c.accountNumberLast4,
  accountHolderName: c.accountHolderName,
  effectiveAt: c.effectiveAt,
});

const audit = (action: AdminAuditAction, change: PayoutAccountChange, actorUserId: string, extra: Record<string, unknown> = {}) =>
  adminAuditService
    .record({
      actorUserId,
      tenantId: change.tenantId,
      action,
      details: {
        changeId: change.id,
        kind: change.kind,
        bankName: change.bankName,
        accountNumberLast4: change.accountNumberLast4,
        accountHolderName: change.accountHolderName,
        effectiveAt: change.effectiveAt,
        ...extra,
      },
    })
    // The step itself has happened; a missing audit row is reported, never
    // undoes it.
    .catch((err: unknown) => console.error(`[payment-account] audit entry ${action} not written for change ${change.id}:`, err));

// ── Creating the subaccount, safely retried ──

// The subaccount made for this change, if Paystack has one: looked for by
// the creationKey in its description, newest first, a few pages back.
const findCreatedSubaccount = async (creationKey: string): Promise<paystackClient.ListedSubaccount | null> => {
  const marker = `${DESCRIPTION_PREFIX} ${creationKey}`;
  for (let page = 1; page <= 5; page++) {
    const { items, pageCount } = await paystackClient.listSubaccounts({ page, perPage: 100 });
    const found = items.find((s) => s.description === marker);
    if (found) return found;
    if (page >= pageCount) return null;
  }
  return null;
};

type CreationOutcome =
  | { kind: 'created'; subaccountCode: string; active: boolean }
  | { kind: 'rejected' }
  | { kind: 'unavailable' } // Paystack certainly didn't act (429): try later.
  | { kind: 'uncertain' }; // It may have: look for it before trying again.

// One attempt: look for it first whenever an earlier attempt may have made
// it, then create it.
const attemptCreation = async (change: PayoutAccountChange, accountNumber: string, lookFirst: boolean): Promise<CreationOutcome> => {
  try {
    if (lookFirst) {
      const existing = await findCreatedSubaccount(change.creationKey);
      if (existing) return { kind: 'created', subaccountCode: existing.subaccountCode, active: existing.active };
    }
    const created = await paystackClient.createSubaccount({
      businessName: change.businessName,
      settlementBank: change.bankCode,
      accountNumber,
      // The subaccount's own default split stays 0: each sale's split is
      // set per transaction (Round B: transaction_charge, bearer account).
      percentageCharge: 0,
      description: `${DESCRIPTION_PREFIX} ${change.creationKey}`,
    });
    return { kind: 'created', subaccountCode: created.subaccountCode, active: created.active };
  } catch (err) {
    console.error(`[payment-account] subaccount creation for change ${change.id} failed: ${describe(err)}`);
    if (isUncertainPaystackFailure(err)) return { kind: 'uncertain' };
    if (err instanceof PaystackApiError && err.kind === 'rejected') return { kind: 'rejected' };
    if (err instanceof PaystackApiError) return { kind: 'unavailable' };
    throw err;
  }
};

const retryDelayMs = (): number => {
  const v = Number(process.env['PAYSTACK_RETRY_DELAY_MS']);
  return Number.isFinite(v) && v >= 0 ? v : 500;
};

// What follows a confirmed subaccount: PENDING, and for the first setup,
// applied at once.
const onCreated = async (change: PayoutAccountChange, created: { subaccountCode: string; active: boolean }, actorUserId: string): Promise<void> => {
  const moved = await paymentAccountRepository.markCreated(change.id, { subaccountCode: created.subaccountCode, subaccountActive: created.active });
  if (!moved) return; // cancelled meanwhile
  const confirmed = { ...change, status: 'PENDING' as const, subaccountCode: created.subaccountCode, subaccountActive: created.active };
  await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_SUBACCOUNT_CREATED, confirmed, actorUserId, { subaccountCode: created.subaccountCode });
  if (change.kind === 'SETUP') await applyChange(confirmed, new Date());
};

// ── Applying a change: it becomes the account sales are paid into ──

// Only once Paystack confirms the new subaccount is active. Any failure
// (Paystack unreachable, or the subaccount not active) leaves the current
// account in use, and the worker tries again.
const applyChange = async (change: PayoutAccountChange, now: Date): Promise<boolean> => {
  if (!change.subaccountCode) return false;
  let active: boolean;
  try {
    active = (await paystackClient.getSubaccount(change.subaccountCode)).active;
  } catch (err) {
    console.error(`[payment-account] change ${change.id} not applied yet: Paystack ${describe(err)}`);
    await paymentAccountRepository.deferApply(change.id, `PAYSTACK_${describe(err)}`, new Date(now.getTime() + 5 * 60_000));
    return false;
  }
  // A first setup is applied whatever Paystack says (there is no other
  // account; readyToSell follows its status). A change never switches a
  // working account to one Paystack hasn't activated.
  if (!active && change.kind === 'CHANGE') {
    await paymentAccountRepository.deferApply(change.id, 'SUBACCOUNT_NOT_ACTIVE', new Date(now.getTime() + 15 * 60_000));
    return false;
  }
  const applied = await paymentAccountRepository.apply(
    { ...change, subaccountCode: change.subaccountCode },
    active ? 'ACTIVE' : 'PENDING',
    now
  );
  if (!applied) return false;
  await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_APPLIED, change, PAYOUT_AUDIT_SYSTEM_ACTOR, { subaccountCode: change.subaccountCode, appliedAt: now });
  const tenant = await paymentAccountRepository.findStatusByTenantId(change.tenantId);
  const orgName = tenant?.name ?? change.tenantId;
  if (change.kind === 'SETUP') await payoutEmails.setUp(emailView(change), orgName);
  else await payoutEmails.changeApplied(emailView(change), orgName);
  // Only now, with the switch committed, is the replaced subaccount unused.
  await deactivateUnused(change.id, now);
  return true;
};

// ── Deactivating subaccounts nobody uses ──
//
// A cancelled or failed change's own subaccount, and the one an applied
// change replaced, are deactivated at Paystack (PUT /subaccount/:code,
// active: false), best effort: tried at once, then by the worker with a
// growing wait (5 minutes doubling, at most 6 hours), never given up.
// Deactivating is the same request however often it is sent, so an unclear
// answer is simply tried again. The organisation's live subaccount is read
// fresh before every call and never deactivated. Each one is audited.

const DEACTIVATION_FIRST_RETRY_MS = 5 * 60_000;
const DEACTIVATION_MAX_RETRY_MS = 6 * 60 * 60_000;

interface DeactivationTarget {
  which: 'OWN' | 'REPLACED';
  subaccountCode: string;
  businessName: string | null;
  bankCode: string | null;
  reason: 'CANCELLED' | 'FAILED' | 'REPLACED';
}

const deactivationTargetOf = (change: PayoutAccountChange): DeactivationTarget | null => {
  if ((change.status === 'CANCELLED' || change.status === 'FAILED') && change.subaccountCode && !change.subaccountDeactivatedAt) {
    return { which: 'OWN', subaccountCode: change.subaccountCode, businessName: change.businessName, bankCode: change.bankCode, reason: change.status };
  }
  if (change.status === 'APPLIED' && change.replacedSubaccountCode && !change.replacedDeactivatedAt) {
    return { which: 'REPLACED', subaccountCode: change.replacedSubaccountCode, businessName: change.replacedBusinessName, bankCode: change.replacedBankCode, reason: 'REPLACED' };
  }
  return null;
};

// Never throws: a failure is recorded on the change for the worker.
const deactivateUnused = async (changeId: string, now: Date): Promise<boolean> => {
  try {
    const change = await paymentAccountRepository.findChangeById(changeId);
    const target = change ? deactivationTargetOf(change) : null;
    if (!change || !target) return false;

    const live = (await paymentAccountRepository.findStatusByTenantId(change.tenantId))?.paystackSubaccountCode ?? null;
    if (live === target.subaccountCode) {
      // It is (again) the account sales are paid into: never deactivated.
      await paymentAccountRepository.markDeactivated(change.id, target.which, now);
      await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED, change, PAYOUT_AUDIT_SYSTEM_ACTOR, {
        subaccountCode: target.subaccountCode,
        reason: target.reason,
        skipped: 'LIVE_ACCOUNT',
      });
      return false;
    }

    try {
      await paystackClient.updateSubaccount(target.subaccountCode, {
        active: false,
        // Sent with it in case Paystack wants them on every update.
        ...(target.businessName && { businessName: target.businessName }),
        ...(target.bankCode && { settlementBank: target.bankCode }),
      });
    } catch (err) {
      console.error(`[payment-account] subaccount ${target.subaccountCode} not deactivated yet (change ${change.id}): ${describe(err)}`);
      const wait = Math.min(DEACTIVATION_FIRST_RETRY_MS * 2 ** change.deactivationAttempts, DEACTIVATION_MAX_RETRY_MS);
      await paymentAccountRepository.deferDeactivation(change.id, `PAYSTACK_${describe(err)}`, new Date(now.getTime() + wait));
      return false;
    }
    await paymentAccountRepository.markDeactivated(change.id, target.which, now);
    await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED, change, PAYOUT_AUDIT_SYSTEM_ACTOR, {
      subaccountCode: target.subaccountCode,
      reason: target.reason,
    });
    return true;
  } catch (err) {
    console.error(`[payment-account] deactivation for change ${changeId} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
};

// ── Setup and change, one flow ──

const submit = async (tenantId: string, userId: string, body: unknown, kind: PayoutAccountChangeKind): Promise<{ dto: PayoutSubmissionDto; confirmed: boolean }> => {
  const tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
  if (!tenant) throw new HttpError(404, ORGANISATION_NOT_FOUND_MESSAGE);
  const account = await parseAccountInput(body);

  const hasAccount = tenant.paystackSubaccountCode !== null;
  if (kind === 'SETUP' && hasAccount) {
    throw new HttpError(409, 'You already have a payout account. Change it instead.', PAYOUT_ERROR_CODES.ACCOUNT_EXISTS);
  }
  if (kind === 'CHANGE' && !hasAccount) {
    throw new HttpError(422, "You haven't set up a payout account yet. Add your bank details first.", PAYOUT_ERROR_CODES.NOT_SET_UP);
  }

  const now = new Date();
  const last4 = account.accountNumber.slice(-4);
  let change: PayoutAccountChange;
  let cancelToken: string | null = null;
  let lookFirst = false;

  const open = await paymentAccountRepository.findOpenChange(tenantId);
  if (open && open.kind === kind && open.status === 'CREATING' && open.subaccountCode === null) {
    // Still unconfirmed (Paystack gave no clear answer): the same change
    // again, under its own creationKey, looked for before creating.
    await paymentAccountRepository.refreshUnconfirmedChange(open.id, {
      businessName: account.businessName,
      bankCode: account.bankCode,
      bankName: account.bankName,
      accountNumberLast4: last4,
      accountHolderName: account.accountHolderName,
    });
    change = { ...open, businessName: account.businessName, bankCode: account.bankCode, bankName: account.bankName, accountNumberLast4: last4, accountHolderName: account.accountHolderName };
    lookFirst = true;
  } else if (open) {
    throw new HttpError(
      409,
      open.kind === 'SETUP'
        ? 'Your payout account is still being set up. Please wait a moment.'
        : 'A payout account change is already waiting. Cancel it first if you want to make a different one.',
      PAYOUT_ERROR_CODES.CHANGE_PENDING
    );
  } else {
    const effectiveAt = kind === 'SETUP' ? now : new Date(now.getTime() + PAYOUT_CHANGE_DELAY_MS);
    cancelToken = kind === 'CHANGE' ? crypto.randomBytes(32).toString('hex') : null;
    try {
      change = await paymentAccountRepository.createChange({
        tenantId,
        kind,
        creationKey: `evpa_${crypto.randomBytes(12).toString('hex')}`,
        businessName: account.businessName,
        bankCode: account.bankCode,
        bankName: account.bankName,
        accountNumberLast4: last4,
        accountHolderName: account.accountHolderName,
        effectiveAt,
        requestedByUserId: userId,
        cancelTokenHash: cancelToken ? hashToken(cancelToken) : null,
        // The link works until the change takes effect.
        cancelTokenExpiresAt: cancelToken ? effectiveAt : null,
      });
    } catch (err) {
      if (isUniqueViolationOfIndex(err, 'PayoutAccountChange_one_open_per_tenant')) {
        throw new HttpError(409, 'A payout account change is already being made. Please wait a moment.', PAYOUT_ERROR_CODES.CHANGE_PENDING);
      }
      throw err;
    }
    await audit(
      kind === 'SETUP' ? ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_SETUP_REQUESTED : ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_CHANGE_REQUESTED,
      change,
      userId
    );
  }

  // Paystack: up to PAYOUT_CREATE_ATTEMPTS here, each after an unclear one
  // looking for the subaccount before creating another.
  let outcome: CreationOutcome = { kind: 'uncertain' };
  for (let attempt = 0; attempt < PAYOUT_CREATE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs()));
    outcome = await attemptCreation(change, account.accountNumber, lookFirst);
    if (outcome.kind === 'uncertain') lookFirst = true;
    // Once any attempt may have created it, nothing short of finding it or
    // a refusal settles it: "unavailable" then still means "may exist".
    if (outcome.kind === 'unavailable' && lookFirst) outcome = { kind: 'uncertain' };
    await paymentAccountRepository.recordAttempt(change.id, {
      error: outcome.kind === 'created' ? null : outcome.kind.toUpperCase(),
      nextAttemptAt: outcome.kind === 'uncertain' ? new Date(Date.now() + 60_000) : null,
    });
    if (outcome.kind !== 'uncertain' && outcome.kind !== 'unavailable') break;
  }

  if (outcome.kind === 'rejected' || outcome.kind === 'unavailable') {
    const rejected = outcome.kind === 'rejected';
    await paymentAccountRepository.markFailed(change.id, rejected ? REJECTED_MESSAGE : PROVIDER_UNAVAILABLE_MESSAGE);
    await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_CHANGE_FAILED, change, userId, { reason: rejected ? 'REJECTED' : 'PROVIDER_UNAVAILABLE' });
    if (rejected && kind === 'SETUP') await paymentAccountRepository.markSetupFailed(tenantId, REJECTED_MESSAGE);
    throw rejected
      ? new HttpError(422, REJECTED_MESSAGE, PAYOUT_ERROR_CODES.REJECTED)
      : new HttpError(503, PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
  }

  if (outcome.kind === 'created') await onCreated(change, outcome, userId);

  // A change is announced as soon as it is asked for, confirmed or not: the
  // admins can stop it from the first moment.
  if (kind === 'CHANGE' && cancelToken) {
    await payoutEmails.changeRequested(emailView(change), tenant.name, cancelToken);
  }

  const status = await paymentAccountService.getStatus(tenantId);
  const saved = (await paymentAccountRepository.findChangeById(change.id)) ?? change;
  return {
    confirmed: outcome.kind === 'created',
    dto: {
      ...status,
      submitted: {
        changeId: saved.id,
        kind: saved.kind,
        bankName: saved.bankName,
        accountNumberLast4: saved.accountNumberLast4,
        accountHolderName: saved.accountHolderName,
        effectiveAt: saved.effectiveAt,
        creationConfirmed: saved.subaccountCode !== null,
      },
    },
  };
};

export const paymentAccountService = {
  getStatus: async (tenantId: string): Promise<SubaccountStatusDto> => {
    let tenant = await paymentAccountRepository.findStatusByTenantId(tenantId);
    if (!tenant) throw new HttpError(404, ORGANISATION_NOT_FOUND_MESSAGE);

    // An account from before the last 4 digits were kept: read once from
    // Paystack and keep only those four. A Paystack outage still shows the
    // status we have.
    if (tenant.paystackSubaccountCode && !tenant.paystackAccountNumberLast4) {
      try {
        const live = await paystackClient.getSubaccount(tenant.paystackSubaccountCode);
        await paymentAccountRepository.cacheVisibleDetails(tenantId, {
          businessName: live.businessName,
          settlementBankName: live.settlementBank,
          accountNumberLast4: live.accountNumber.slice(-4),
        });
        tenant = (await paymentAccountRepository.findStatusByTenantId(tenantId)) ?? tenant;
      } catch (err) {
        console.error(`[payment-account] last-4 backfill failed for tenant ${tenantId}: ${describe(err)}`);
      }
    }
    return toStatusDto(tenant, await paymentAccountRepository.findOpenChange(tenantId));
  },

  listBanks: () => listBanks(),

  // POST: the first setup. Takes effect at once once Paystack confirms.
  setUp: (tenantId: string, userId: string, body: unknown) => submit(tenantId, userId, body, 'SETUP'),

  // PUT: a change. Takes effect 24 hours later.
  requestChange: (tenantId: string, userId: string, body: unknown) => submit(tenantId, userId, body, 'CHANGE'),

  // A Tenant Admin cancels the waiting change from the app.
  cancelFromApp: async (tenantId: string, userId: string): Promise<SubaccountStatusDto> => {
    const open = await paymentAccountRepository.findOpenChange(tenantId);
    if (!open || open.kind !== 'CHANGE') {
      throw new HttpError(404, 'There is no payout account change waiting.', PAYOUT_ERROR_CODES.NO_CHANGE_PENDING);
    }
    const now = new Date();
    if (!(await paymentAccountRepository.cancelOpen({ id: open.id }, { via: 'APP', userId, now }))) {
      throw new HttpError(409, 'This change has already taken effect or been cancelled.', PAYOUT_ERROR_CODES.CHANGE_NOT_PENDING);
    }
    await afterCancel(open, 'APP', userId);
    return paymentAccountService.getStatus(tenantId);
  },

  // The email's link: no sign-in, the token in the body. Single use, until
  // the change takes effect.
  cancelByLink: async (token: unknown): Promise<{ cancelled: true; bankName: string; accountNumberLast4: string }> => {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
      throw new HttpError(404, "This link isn't valid. Sign in to e-velope to see your payout account.", PAYOUT_ERROR_CODES.CANCEL_LINK_INVALID);
    }
    const change = await paymentAccountRepository.findChangeByCancelTokenHash(hashToken(token));
    if (!change) {
      throw new HttpError(404, "This link isn't valid. Sign in to e-velope to see your payout account.", PAYOUT_ERROR_CODES.CANCEL_LINK_INVALID);
    }
    const now = new Date();
    if (change.cancelTokenUsedAt) {
      throw new HttpError(410, 'This link has already been used. The change was cancelled.', PAYOUT_ERROR_CODES.CANCEL_LINK_USED);
    }
    if (!change.cancelTokenExpiresAt || change.cancelTokenExpiresAt <= now) {
      throw new HttpError(410, 'This link has expired: the change has already taken effect. Sign in to e-velope to change your payout account again.', PAYOUT_ERROR_CODES.CANCEL_LINK_EXPIRED);
    }
    if (change.status !== 'CREATING' && change.status !== 'PENDING') {
      throw new HttpError(409, 'This change has already been cancelled or has taken effect.', PAYOUT_ERROR_CODES.CHANGE_NOT_PENDING);
    }
    if (!(await paymentAccountRepository.cancelOpen({ id: change.id }, { via: 'EMAIL_LINK', userId: null, now }))) {
      // Another use, or a cancel in the app, won the race.
      throw new HttpError(410, 'This link has already been used. The change was cancelled.', PAYOUT_ERROR_CODES.CANCEL_LINK_USED);
    }
    await afterCancel(change, 'EMAIL_LINK', null);
    return { cancelled: true, bankName: change.bankName, accountNumberLast4: change.accountNumberLast4 };
  },

  // ── The worker's two jobs (payment-account.worker.ts) ──

  // Unconfirmed creations: look for the subaccount by its key. Found:
  // confirmed. Not found after PAYOUT_CONFIRMATION_WINDOW_MS: failed (the
  // worker never has the account number, so it can't create one itself).
  confirmPending: async (now: Date, tenantIds?: string[]): Promise<number> => {
    let confirmed = 0;
    for (const change of await paymentAccountRepository.findDueForConfirmation(now, tenantIds)) {
      let found: paystackClient.ListedSubaccount | null;
      try {
        found = await findCreatedSubaccount(change.creationKey);
      } catch (err) {
        await paymentAccountRepository.recordAttempt(change.id, { error: `LOOKUP_${describe(err)}`, nextAttemptAt: new Date(now.getTime() + 5 * 60_000) });
        continue;
      }
      if (found) {
        await onCreated(change, { subaccountCode: found.subaccountCode, active: found.active }, PAYOUT_AUDIT_SYSTEM_ACTOR);
        confirmed++;
        continue;
      }
      if (now.getTime() - change.createdAt.getTime() >= PAYOUT_CONFIRMATION_WINDOW_MS) {
        if (await paymentAccountRepository.markFailed(change.id, CONFIRMATION_FAILED_REASON)) {
          await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_CHANGE_FAILED, change, PAYOUT_AUDIT_SYSTEM_ACTOR, { reason: 'NOT_CONFIRMED' });
          const tenant = await paymentAccountRepository.findStatusByTenantId(change.tenantId);
          await payoutEmails.changeFailed(emailView(change), tenant?.name ?? change.tenantId);
        }
        continue;
      }
      await paymentAccountRepository.recordAttempt(change.id, { error: 'NOT_FOUND_YET', nextAttemptAt: new Date(now.getTime() + 5 * 60_000) });
    }
    return confirmed;
  },

  // Confirmed changes whose effectiveAt has come.
  applyDue: async (now: Date, tenantIds?: string[]): Promise<number> => {
    let applied = 0;
    for (const change of await paymentAccountRepository.findDueToApply(now, tenantIds)) {
      if (await applyChange(change, now)) applied++;
    }
    return applied;
  },

  // Unused subaccounts still to deactivate (deactivateUnused), due now.
  deactivateDue: async (now: Date, tenantIds?: string[]): Promise<number> => {
    let deactivated = 0;
    for (const change of await paymentAccountRepository.findDueForDeactivation(now, tenantIds)) {
      if (await deactivateUnused(change.id, now)) deactivated++;
    }
    return deactivated;
  },
};

const afterCancel = async (change: PayoutAccountChange, via: 'APP' | 'EMAIL_LINK', userId: string | null): Promise<void> => {
  // The link needs no sign-in, so who used it isn't known: its own actor.
  await audit(ADMIN_AUDIT_ACTIONS.PAYOUT_ACCOUNT_CHANGE_CANCELLED, change, userId ?? PAYOUT_AUDIT_EMAIL_LINK_ACTOR, { via });
  const tenant = await paymentAccountRepository.findStatusByTenantId(change.tenantId);
  await payoutEmails.changeCancelled(emailView(change), tenant?.name ?? change.tenantId, via);
  // Its subaccount (if Paystack made one) is no one's now.
  await deactivateUnused(change.id, new Date());
};
