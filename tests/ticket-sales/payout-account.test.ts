import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock, createActor } from '../helpers/team.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { payoutAccountWorker } from '../../src/modules/payment-account/payment-account.worker.js';
import { PAYOUT_CHANGE_DELAY_MS, PAYOUT_CONFIRMATION_WINDOW_MS } from '../../src/modules/payment-account/payment-account.service.js';
import { scrubText, scrubValue } from '../../src/shared/monitoring/sentry-scrub.js';
import { ACCOUNT_NUMBER, OTHER_ACCOUNT_NUMBER, PAYOUT_URL, cleanupTicketSalesFixtures, createOrg, prisma, type Org } from './helpers.js';

// ─────────────────────────────────────────
//  THE PAYOUT ACCOUNT (ticket sales Round A) — /api/payments/subaccount
//
//  One per organisation, Tenant Admins only. The first setup takes effect at
//  once; a change creates a NEW subaccount that waits 24 hours (an email
//  with a single-use cancel link, cancellable in the app too), and the
//  worker switches it, leaving the current account in use through any
//  Paystack failure. Creation is safe to retry. The account number is never
//  stored, logged or returned.
// ─────────────────────────────────────────

const ALERTS = 'admin@e-velope.co.za';
const HOUR = 60 * 60 * 1000;

const account = (accountNumber = ACCOUNT_NUMBER, holder = 'Acme Events (Pty) Ltd') => ({
  settlementBank: '000',
  accountNumber,
  accountHolderName: holder,
});

const setUp = (org: Org, body = account()) => request(app).post(PAYOUT_URL).set(headersFor(org.admin)).send(body);
const change = (org: Org, body = account(OTHER_ACCOUNT_NUMBER, 'Acme Events New')) =>
  request(app).put(PAYOUT_URL).set(headersFor(org.admin)).send(body);
const status = (org: Org) => request(app).get(PAYOUT_URL).set(headersFor(org.admin));
const cancelByLink = (token: unknown) => request(app).post(`${PAYOUT_URL}/change/cancel-by-link`).send({ token });
const tenantOf = (org: Org) => prisma.tenant.findUniqueOrThrow({ where: { id: org.tenantId } });
const auditActions = async (org: Org) =>
  (await prisma.adminAuditEntry.findMany({ where: { tenantId: org.tenantId }, orderBy: { createdAt: 'asc' } })).map((e) => e.action);
const runWorker = (org: Org, now: Date) => payoutAccountWorker.runOnce({ now, tenantIds: [org.tenantId] });
const emailsTo = (to: string) => sentEmails().filter((e) => e.to === to);

// The cancel link from the change email: <frontend>/payout-account/cancel-change#token=<hex>
const cancelLinkIn = (html: string): URL => {
  const match = html.match(/href="([^"]*payout-account\/cancel-change[^"]*)"/);
  if (!match) throw new Error('no cancel link in the email');
  return new URL(match[1]!.replace(/&amp;/g, '&'));
};

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await cleanupTicketSalesFixtures();
});

describe('first setup', () => {
  it('is active at once, emailed to the admins and the super admin, and audited', async () => {
    const org = await createOrg();
    const res = await setUp(org);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      state: 'ACTIVE',
      status: 'ACTIVE',
      readyToSell: true,
      bankName: 'Fake Bank',
      accountNumberLast4: '5678',
      accountHolderName: 'Acme Events (Pty) Ltd',
      pendingChange: null,
      submitted: { kind: 'SETUP', bankName: 'Fake Bank', accountNumberLast4: '5678', accountHolderName: 'Acme Events (Pty) Ltd', creationConfirmed: true },
    });
    expect(res.body.data.activeSince).not.toBeNull();

    const tenant = await tenantOf(org);
    expect(tenant.paystackSubaccountStatus).toBe('ACTIVE');
    expect(tenant.paystackSubaccountCode).toMatch(/^ACCT_/);
    expect(fakePaystack.subaccounts.size).toBe(1);

    expect(emailsTo(org.admin.email).map((e) => e.subject)).toEqual(['Your payout account is set up']);
    expect(emailsTo(ALERTS).map((e) => e.subject)).toEqual(['Your payout account is set up']);
    expect(await auditActions(org)).toEqual(['PAYOUT_ACCOUNT_SETUP_REQUESTED', 'PAYOUT_ACCOUNT_SUBACCOUNT_CREATED', 'PAYOUT_ACCOUNT_APPLIED']);

    // A second setup is a change, not another setup.
    const again = await setUp(org);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PAYOUT_ACCOUNT_EXISTS');
  }, 60000);

  it('reads the bank from Paystack\'s South African list, and refuses one not on it', async () => {
    const org = await createOrg();
    const banks = await request(app).get(`${PAYOUT_URL}/banks`).set(headersFor(org.admin));
    expect(banks.status).toBe(200);
    expect(banks.body.data).toEqual([{ name: 'Fake Bank', code: '000' }]);
    const bankCall = fakePaystack.callsTo('GET', '/bank').at(-1);
    if (bankCall) expect(bankCall.query).toMatchObject({ country: 'south africa', currency: 'ZAR' });

    const res = await setUp(org, { ...account(), settlementBank: '999' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYOUT_BANK_UNKNOWN');
    expect(fakePaystack.subaccounts.size).toBe(0);
  }, 60000);
});

describe('a change', () => {
  it('waits 24 hours with the current account in use, then switches, emailed and audited', async () => {
    const org = await createOrg();
    await setUp(org);
    const before = await tenantOf(org);
    clearSentEmails();

    const requestedAt = Date.now();
    const res = await change(org);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      state: 'CHANGE_PENDING',
      accountNumberLast4: '5678', // still the current account
      readyToSell: true,
      pendingChange: { kind: 'CHANGE', status: 'PENDING', accountNumberLast4: '4321', accountHolderName: 'Acme Events New', creationConfirmed: true },
      submitted: { kind: 'CHANGE', accountNumberLast4: '4321', creationConfirmed: true },
    });
    const effectiveAt = new Date(res.body.data.pendingChange.effectiveAt).getTime();
    expect(effectiveAt - requestedAt).toBeGreaterThanOrEqual(PAYOUT_CHANGE_DELAY_MS - 5_000);
    expect(effectiveAt - requestedAt).toBeLessThanOrEqual(PAYOUT_CHANGE_DELAY_MS + 5_000);
    expect(PAYOUT_CHANGE_DELAY_MS).toBe(24 * HOUR);

    // Emailed to the organisation's admins (with the cancel link) and the super admin.
    expect(emailsTo(org.admin.email).map((e) => e.subject)).toEqual(['Your payout account is changing in 24 hours']);
    expect(emailsTo(ALERTS).map((e) => e.subject)).toEqual(['Your payout account is changing in 24 hours']);
    expect(emailsTo(ALERTS)[0]!.html).not.toMatch(/cancel-change/);

    // 23 hours on: nothing has switched.
    expect(await runWorker(org, new Date(requestedAt + 23 * HOUR))).toMatchObject({ confirmed: 0, applied: 0 });
    expect((await tenantOf(org)).paystackSubaccountCode).toBe(before.paystackSubaccountCode);

    // At effectiveAt: switched, and emailed again.
    expect(await runWorker(org, new Date(effectiveAt + 60_000))).toMatchObject({ confirmed: 0, applied: 1 });
    const after = await tenantOf(org);
    expect(after.paystackSubaccountCode).not.toBe(before.paystackSubaccountCode);
    expect(after).toMatchObject({ paystackSubaccountStatus: 'ACTIVE', paystackAccountNumberLast4: '4321', paystackAccountHolderName: 'Acme Events New' });
    expect((await status(org)).body.data).toMatchObject({ state: 'ACTIVE', pendingChange: null, accountNumberLast4: '4321' });
    expect(emailsTo(org.admin.email).map((e) => e.subject)).toContain('Your new payout account is now in use');
    expect(await auditActions(org)).toEqual([
      'PAYOUT_ACCOUNT_SETUP_REQUESTED', 'PAYOUT_ACCOUNT_SUBACCOUNT_CREATED', 'PAYOUT_ACCOUNT_APPLIED',
      'PAYOUT_ACCOUNT_CHANGE_REQUESTED', 'PAYOUT_ACCOUNT_SUBACCOUNT_CREATED', 'PAYOUT_ACCOUNT_APPLIED',
      // The replaced subaccount, deactivated once the switch is done.
      'PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED',
    ]);
    // A second run changes nothing.
    expect(await runWorker(org, new Date(effectiveAt + 2 * HOUR))).toMatchObject({ confirmed: 0, applied: 0 });
  }, 60000);

  it('one change at a time: another is refused until the first is cancelled', async () => {
    const org = await createOrg();
    await setUp(org);
    expect((await change(org)).status).toBe(200);
    const second = await change(org, account('11112222333', 'Someone Else'));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PAYOUT_CHANGE_PENDING');
  }, 60000);
});

describe('cancelling a change', () => {
  it('by the email link: no sign-in, the token never in a URL path, once only, and nothing switches', async () => {
    const org = await createOrg();
    await setUp(org);
    const before = await tenantOf(org);
    clearSentEmails();
    const res = await change(org);
    const link = cancelLinkIn(emailsTo(org.admin.email)[0]!.html);

    // The token is in the fragment: never in the path or the query string.
    const token = new URLSearchParams(link.hash.slice(1)).get('token')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(link.pathname).toBe('/payout-account/cancel-change');
    expect(link.pathname).not.toContain(token);
    expect(link.search).toBe('');
    // The API takes it in the body only: with it in the path there is no such
    // route (it falls to the signed-in routes: 401), and nothing is cancelled.
    expect((await request(app).post(`${PAYOUT_URL}/change/cancel-by-link/${token}`)).status).toBe(401);
    expect((await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } })).status).toBe('PENDING');

    const cancelled = await cancelByLink(token);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toEqual({ cancelled: true, bankName: 'Fake Bank', accountNumberLast4: '4321' });
    const row = await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } });
    expect(row).toMatchObject({ status: 'CANCELLED', cancelledVia: 'EMAIL_LINK' });
    expect(row.cancelTokenUsedAt).not.toBeNull();

    // Once only.
    const again = await cancelByLink(token);
    expect(again.status).toBe(410);
    expect(again.body.code).toBe('PAYOUT_CANCEL_LINK_USED');

    // Nothing switches at effectiveAt.
    expect(await runWorker(org, new Date(Date.now() + PAYOUT_CHANGE_DELAY_MS + HOUR))).toMatchObject({ confirmed: 0, applied: 0 });
    expect((await tenantOf(org)).paystackSubaccountCode).toBe(before.paystackSubaccountCode);
    expect(emailsTo(org.admin.email).map((e) => e.subject)).toContain('Your payout account change was cancelled');
    expect(await auditActions(org)).toContain('PAYOUT_ACCOUNT_CHANGE_CANCELLED');
  }, 60000);

  it('the link expires when the change takes effect, and an unknown one is refused', async () => {
    const org = await createOrg();
    await setUp(org);
    clearSentEmails();
    const res = await change(org);
    const token = new URLSearchParams(cancelLinkIn(emailsTo(org.admin.email)[0]!.html).hash.slice(1)).get('token')!;
    const row = await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } });
    expect(row.cancelTokenExpiresAt?.getTime()).toBe(row.effectiveAt.getTime());

    await prisma.payoutAccountChange.update({ where: { id: row.id }, data: { cancelTokenExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await cancelByLink(token);
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('PAYOUT_CANCEL_LINK_EXPIRED');
    expect((await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');

    const unknown = await cancelByLink('a'.repeat(64));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('PAYOUT_CANCEL_LINK_INVALID');
    expect((await cancelByLink(undefined)).status).toBe(404);
  }, 60000);

  it('from the app, by a Tenant Admin: nothing switches', async () => {
    const org = await createOrg();
    await setUp(org);
    const before = await tenantOf(org);
    const res = await change(org);

    const cancelled = await request(app).post(`${PAYOUT_URL}/change/cancel`).set(headersFor(org.admin)).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ state: 'ACTIVE', pendingChange: null, accountNumberLast4: '5678' });
    expect(await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } })).toMatchObject({
      status: 'CANCELLED',
      cancelledVia: 'APP',
      cancelledByUserId: org.admin.id,
    });
    expect(await runWorker(org, new Date(Date.now() + PAYOUT_CHANGE_DELAY_MS + HOUR))).toMatchObject({ confirmed: 0, applied: 0 });
    expect((await tenantOf(org)).paystackSubaccountCode).toBe(before.paystackSubaccountCode);

    const nothing = await request(app).post(`${PAYOUT_URL}/change/cancel`).set(headersFor(org.admin)).send({});
    expect(nothing.status).toBe(404);
    expect(nothing.body.code).toBe('PAYOUT_NO_CHANGE_PENDING');
  }, 60000);
});

describe('Paystack failing during a change leaves the current account in use', () => {
  it('Paystack refusing the new details: 422 in our words, the current account untouched and still ACTIVE', async () => {
    const org = await createOrg();
    await setUp(org);
    const before = await tenantOf(org);
    fakePaystack.failNext('POST /subaccount', { status: 400, body: { status: false, message: `Account number ${OTHER_ACCOUNT_NUMBER} could not be resolved` } });

    const res = await change(org);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYOUT_ACCOUNT_REJECTED');
    expect(res.body.message).not.toMatch(/resolved|Paystack/);

    const after = await tenantOf(org);
    expect(after).toMatchObject({
      paystackSubaccountCode: before.paystackSubaccountCode,
      paystackSubaccountStatus: 'ACTIVE',
      paystackSubaccountFailureReason: null,
    });
    expect((await status(org)).body.data).toMatchObject({ state: 'ACTIVE', readyToSell: true, pendingChange: null });
    expect(await auditActions(org)).toContain('PAYOUT_ACCOUNT_CHANGE_FAILED');
  }, 60000);

  it('no answer from Paystack: the change waits unconfirmed, sales stay on the current account, and it fails after an hour unfound', async () => {
    const org = await createOrg();
    await setUp(org);
    const before = await tenantOf(org);
    fakePaystack.failNext('POST /subaccount', 'timeout', 2);

    const res = await change(org);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ state: 'CHANGE_PENDING', readyToSell: true, pendingChange: { status: 'CREATING', creationConfirmed: false } });
    expect(await tenantOf(org)).toMatchObject({ paystackSubaccountCode: before.paystackSubaccountCode, paystackSubaccountStatus: 'ACTIVE' });

    // Looked for and not found: still waiting, then given up after an hour.
    const changeId = res.body.data.pendingChange.id;
    expect(await runWorker(org, new Date(Date.now() + 2 * 60_000))).toMatchObject({ confirmed: 0, applied: 0 });
    expect((await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: changeId } })).status).toBe('CREATING');
    clearSentEmails();
    await runWorker(org, new Date(Date.now() + PAYOUT_CONFIRMATION_WINDOW_MS + 10 * 60_000));
    expect((await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: changeId } })).status).toBe('FAILED');
    expect(emailsTo(org.admin.email).map((e) => e.subject)).toEqual(["Your payout account change didn't go through"]);
    expect(await tenantOf(org)).toMatchObject({ paystackSubaccountCode: before.paystackSubaccountCode, paystackSubaccountStatus: 'ACTIVE' });
  }, 60000);

  it('Paystack unreachable when the 24 hours are up: not switched, and switched on the next run', async () => {
    const org = await createOrg();
    await setUp(org);
    const before = await tenantOf(org);
    const res = await change(org);
    const effectiveAt = new Date(res.body.data.pendingChange.effectiveAt).getTime();
    const code = (await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } })).subaccountCode!;

    fakePaystack.failNext(`GET /subaccount/${code}`, 'network', 3);
    expect(await runWorker(org, new Date(effectiveAt + 60_000))).toMatchObject({ confirmed: 0, applied: 0 });
    expect(await tenantOf(org)).toMatchObject({ paystackSubaccountCode: before.paystackSubaccountCode, paystackSubaccountStatus: 'ACTIVE' });

    expect(await runWorker(org, new Date(effectiveAt + 10 * 60_000))).toMatchObject({ confirmed: 0, applied: 1 });
    expect((await tenantOf(org)).paystackSubaccountCode).toBe(code);
  }, 60000);
});

describe('creation is safe to retry', () => {
  it('Paystack made the subaccount but the answer was lost: the retry finds it instead of making another', async () => {
    const org = await createOrg();
    await setUp(org);
    fakePaystack.failNext('POST /subaccount', 'timeoutAfterApplying');

    const res = await change(org);
    expect(res.status).toBe(200);
    expect(res.body.data.pendingChange).toMatchObject({ status: 'PENDING', creationConfirmed: true });
    // The setup's subaccount and ONE for the change.
    expect(fakePaystack.subaccounts.size).toBe(2);
    expect(fakePaystack.callsTo('POST', '/subaccount')).toHaveLength(2);
    const row = await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } });
    expect(fakePaystack.subaccounts.get(row.subaccountCode!)?.description).toBe(`e-velope payout ${row.creationKey}`);
  }, 60000);

  it('still unclear after the request: the worker adopts it, and the admin re-sending the details makes no second one', async () => {
    const org = await createOrg();
    await setUp(org);
    fakePaystack.failNext('POST /subaccount', 'timeoutAfterApplying');
    fakePaystack.failNext('GET /subaccount', 'timeout', 3); // the retry's look-up, every read retry

    const res = await change(org);
    expect(res.status).toBe(202);
    expect(res.body.data.pendingChange).toMatchObject({ status: 'CREATING', creationConfirmed: false });
    expect(fakePaystack.subaccounts.size).toBe(2);

    // Re-sent: the same change, looked for first, found.
    const resent = await change(org);
    expect(resent.status).toBe(200);
    expect(resent.body.data.pendingChange).toMatchObject({ id: res.body.data.pendingChange.id, status: 'PENDING', creationConfirmed: true });
    expect(fakePaystack.subaccounts.size).toBe(2);
  }, 60000);

  it('the worker confirms an unclear creation by finding it', async () => {
    const org = await createOrg();
    await setUp(org);
    fakePaystack.failNext('POST /subaccount', 'timeoutAfterApplying');
    fakePaystack.failNext('GET /subaccount', 'timeout', 3);
    const res = await change(org);
    expect(res.status).toBe(202);

    expect(await runWorker(org, new Date(Date.now() + 2 * 60_000))).toMatchObject({ confirmed: 1, applied: 0 });
    expect(await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: res.body.data.pendingChange.id } })).toMatchObject({ status: 'PENDING' });
    expect(fakePaystack.subaccounts.size).toBe(2);
  }, 60000);
});

describe('the full account number', () => {
  it('is never stored, logged or returned (and Sentry masks it)', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${JSON.stringify(a)} ${String((a as { raw?: unknown }).raw ? JSON.stringify((a as { raw?: unknown }).raw) : '')}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
    const org = await createOrg();
    const responses: unknown[] = [];
    responses.push((await setUp(org)).body);
    // A refusal whose Paystack text quotes the number.
    fakePaystack.failNext('POST /subaccount', { status: 400, body: { status: false, message: `Account number ${OTHER_ACCOUNT_NUMBER} is invalid` } });
    responses.push((await change(org)).body);
    // An unclear one, then a real change.
    fakePaystack.failNext('POST /subaccount', 'timeout', 2);
    responses.push((await change(org)).body);
    responses.push((await change(org)).body);
    responses.push((await status(org)).body);

    const stored = JSON.stringify([
      await prisma.tenant.findUniqueOrThrow({ where: { id: org.tenantId } }),
      await prisma.payoutAccountChange.findMany({ where: { tenantId: org.tenantId } }),
      await prisma.adminAuditEntry.findMany({ where: { tenantId: org.tenantId } }),
    ]);
    const emails = JSON.stringify(sentEmails());
    for (const number of [ACCOUNT_NUMBER, OTHER_ACCOUNT_NUMBER]) {
      expect(stored).not.toContain(number);
      expect(JSON.stringify(responses)).not.toContain(number);
      expect(logged.join('\n')).not.toContain(number);
      expect(emails).not.toContain(number);
    }
    // Last 4 digits only.
    expect(stored).toContain('5678');

    // Sentry: by key, and written out in text.
    expect(JSON.stringify(scrubValue({ accountNumber: ACCOUNT_NUMBER, body: { account_number: ACCOUNT_NUMBER } }))).not.toContain(ACCOUNT_NUMBER);
    expect(scrubText(`{"account_number":"${ACCOUNT_NUMBER}","bank":"000"}`)).not.toContain(ACCOUNT_NUMBER);
    expect(scrubText(`accountNumber=${ACCOUNT_NUMBER}&x=1`)).not.toContain(ACCOUNT_NUMBER);
  }, 60000);
});

describe('who can see or change it', () => {
  it('Tenant Admins only: an Event Admin is 403, signed out is 401, and a super admin (no organisation) is refused', async () => {
    const org = await createOrg();
    await setUp(org);
    const ea = headersFor(org.eventAdmin);
    expect((await request(app).get(PAYOUT_URL).set(ea)).status).toBe(403);
    expect((await request(app).get(`${PAYOUT_URL}/banks`).set(ea)).status).toBe(403);
    expect((await request(app).post(PAYOUT_URL).set(ea).send(account())).status).toBe(403);
    expect((await request(app).put(PAYOUT_URL).set(ea).send(account(OTHER_ACCOUNT_NUMBER))).status).toBe(403);
    expect((await request(app).post(`${PAYOUT_URL}/change/cancel`).set(ea).send({})).status).toBe(403);
    expect((await request(app).get(PAYOUT_URL)).status).toBe(401);

    const superAdmin = await createActor('SUPER_ADMIN', null);
    try {
      const res = await request(app).get(PAYOUT_URL).set(headersFor(superAdmin));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('5678');
    } finally {
      await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
      await prisma.user.delete({ where: { id: superAdmin.id } });
    }
    // Nothing changed by any of them.
    expect(await prisma.payoutAccountChange.count({ where: { tenantId: org.tenantId } })).toBe(1);
  }, 60000);

  it("another organisation's admin only ever sees their own", async () => {
    const org = await createOrg();
    await setUp(org);
    const other = await createOrg();
    const res = await status(other);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'NONE', accountNumberLast4: null, subaccountCode: null });
  }, 60000);
});

describe('unused subaccounts are deactivated at Paystack', () => {
  const pendingCodeOf = async (changeId: string) =>
    (await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: changeId } })).subaccountCode!;
  const deactivations = (code: string) => fakePaystack.callsTo('PUT', `/subaccount/${code}`).filter((c) => c.body?.['active'] === false);

  it('cancelling deactivates the pending subaccount and leaves the live one alone (app and email link), audited', async () => {
    for (const via of ['APP', 'EMAIL_LINK'] as const) {
      const org = await createOrg();
      await setUp(org);
      const live = (await tenantOf(org)).paystackSubaccountCode!;
      clearSentEmails();
      const res = await change(org);
      const pending = await pendingCodeOf(res.body.data.pendingChange.id);
      expect(fakePaystack.subaccounts.get(pending)?.active).toBe(true);

      if (via === 'APP') {
        expect((await request(app).post(`${PAYOUT_URL}/change/cancel`).set(headersFor(org.admin)).send({})).status).toBe(200);
      } else {
        const token = new URLSearchParams(cancelLinkIn(emailsTo(org.admin.email)[0]!.html).hash.slice(1)).get('token')!;
        expect((await cancelByLink(token)).status).toBe(200);
      }
      expect(fakePaystack.subaccounts.get(pending)?.active, via).toBe(false);
      expect(fakePaystack.subaccounts.get(live)?.active, via).toBe(true);
      expect(deactivations(live), via).toHaveLength(0);
      expect((await tenantOf(org)).paystackSubaccountCode).toBe(live);
      const entry = await prisma.adminAuditEntry.findFirstOrThrow({ where: { tenantId: org.tenantId, action: 'PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED' } });
      expect(entry.details).toMatchObject({ subaccountCode: pending, reason: 'CANCELLED' });
    }
  }, 60000);

  it('a failed deactivation is retried by the worker, and never touches the live account', async () => {
    const org = await createOrg();
    await setUp(org);
    const live = (await tenantOf(org)).paystackSubaccountCode!;
    const res = await change(org);
    const changeId = res.body.data.pendingChange.id;
    const pending = await pendingCodeOf(changeId);

    fakePaystack.failNext(`PUT /subaccount/${pending}`, 'timeout');
    expect((await request(app).post(`${PAYOUT_URL}/change/cancel`).set(headersFor(org.admin)).send({})).status).toBe(200);
    expect(fakePaystack.subaccounts.get(pending)?.active).toBe(true);
    const row = await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: changeId } });
    expect(row).toMatchObject({ subaccountDeactivatedAt: null, deactivationAttempts: 1 });
    expect(row.lastDeactivationError).toMatch(/timeout/);

    // Not before its wait; then done.
    expect(await runWorker(org, new Date(Date.now() + 60_000))).toMatchObject({ deactivated: 0 });
    fakePaystack.failNext(`PUT /subaccount/${pending}`, { status: 500 });
    expect(await runWorker(org, new Date(Date.now() + 6 * 60_000))).toMatchObject({ deactivated: 0 });
    expect(await runWorker(org, new Date(Date.now() + 30 * 60_000))).toMatchObject({ deactivated: 1 });
    expect(fakePaystack.subaccounts.get(pending)?.active).toBe(false);
    expect((await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: changeId } })).subaccountDeactivatedAt).not.toBeNull();

    // The live account, through all of it: active, in use, never asked.
    expect(fakePaystack.subaccounts.get(live)?.active).toBe(true);
    expect(deactivations(live)).toHaveLength(0);
    expect(await tenantOf(org)).toMatchObject({ paystackSubaccountCode: live, paystackSubaccountStatus: 'ACTIVE' });
    // Nothing left to do.
    expect(await runWorker(org, new Date(Date.now() + 24 * HOUR))).toMatchObject({ deactivated: 0 });
  }, 60000);

  it('when a change takes effect, the old subaccount is deactivated, only after the switch', async () => {
    const org = await createOrg();
    await setUp(org);
    const old = (await tenantOf(org)).paystackSubaccountCode!;
    const res = await change(org);
    const changeId = res.body.data.pendingChange.id;
    const next = await pendingCodeOf(changeId);
    const effectiveAt = new Date(res.body.data.pendingChange.effectiveAt).getTime();

    // Before the switch: the old account is in use and untouched.
    await runWorker(org, new Date(effectiveAt - HOUR));
    expect(deactivations(old)).toHaveLength(0);

    // The switch can't happen (Paystack unreachable): still nothing deactivated.
    fakePaystack.failNext(`GET /subaccount/${next}`, 'network', 3);
    expect(await runWorker(org, new Date(effectiveAt + 60_000))).toMatchObject({ applied: 0, deactivated: 0 });
    expect(deactivations(old)).toHaveLength(0);
    expect(fakePaystack.subaccounts.get(old)?.active).toBe(true);

    expect(await runWorker(org, new Date(effectiveAt + 10 * 60_000))).toMatchObject({ applied: 1 });
    expect((await tenantOf(org)).paystackSubaccountCode).toBe(next);
    expect(fakePaystack.subaccounts.get(old)?.active).toBe(false);
    expect(fakePaystack.subaccounts.get(next)?.active).toBe(true);
    expect(deactivations(next)).toHaveLength(0);
    expect(await prisma.payoutAccountChange.findUniqueOrThrow({ where: { id: changeId } })).toMatchObject({ replacedSubaccountCode: old });
    const entry = await prisma.adminAuditEntry.findFirstOrThrow({ where: { tenantId: org.tenantId, action: 'PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED' } });
    expect(entry.details).toMatchObject({ subaccountCode: old, reason: 'REPLACED' });
  }, 60000);

  it('a subaccount that is (again) the live one is never deactivated', async () => {
    const org = await createOrg();
    await setUp(org);
    const res = await change(org);
    const changeId = res.body.data.pendingChange.id;
    const pending = await pendingCodeOf(changeId);
    // As if it had become the live account some other way.
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountCode: pending } });
    await prisma.payoutAccountChange.update({ where: { id: changeId }, data: { status: 'CANCELLED' } });
    await runWorker(org, new Date(Date.now() + 60_000));
    expect(deactivations(pending)).toHaveLength(0);
    expect(fakePaystack.subaccounts.get(pending)?.active).toBe(true);
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountCode: null } });
  }, 60000);
});
