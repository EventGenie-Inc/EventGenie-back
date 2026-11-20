import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';
import { mockVerifyIdToken } from '../setup.js';
import { prisma, createTestEvent, deleteTestEvent } from '../helpers/fixtures.js';
import { termsAcceptedUnless } from '../helpers/db.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sentEmails } from '../helpers/sent-emails.js';
import { sentWebhookKeys, sentWebhookIds } from '../helpers/paystack-webhook.js';
import { SUBSCRIPTION_PRICES_CENTS } from '../../src/modules/subscription/subscription-plans.config.js';

// ─────────────────────────────────────────
//  PAYMENTS SUITE FIXTURES (payments release 1)
//
//  A tenant with a TENANT_ADMIN and a published event, sign-in headers the
//  real `authenticate` accepts (Firebase stubbed at verifyIdToken, as
//  everywhere), the four plan codes the fake Paystack knows, and cleanup of
//  every row a test made (the ledger, mismatches and webhook dedupe rows
//  included: fixtures on the test database only; in the product the ledger
//  is append-only).
// ─────────────────────────────────────────

export const PLAN = {
  CELEBRATE_MONTHLY: 'PLN_fake_celebrate_monthly',
  CELEBRATE_ANNUAL: 'PLN_fake_celebrate_annual',
  ELEVATE_MONTHLY: 'PLN_fake_elevate_monthly',
  ELEVATE_ANNUAL: 'PLN_fake_elevate_annual',
};

export const usePlanCodes = (): void => {
  vi.stubEnv('PAYSTACK_PLAN_CELEBRATE_MONTHLY', PLAN.CELEBRATE_MONTHLY);
  vi.stubEnv('PAYSTACK_PLAN_CELEBRATE_ANNUAL', PLAN.CELEBRATE_ANNUAL);
  vi.stubEnv('PAYSTACK_PLAN_ELEVATE_MONTHLY', PLAN.ELEVATE_MONTHLY);
  vi.stubEnv('PAYSTACK_PLAN_ELEVATE_ANNUAL', PLAN.ELEVATE_ANNUAL);
  fakePaystack.planAmounts.set(PLAN.CELEBRATE_MONTHLY, SUBSCRIPTION_PRICES_CENTS.CELEBRATE.MONTHLY);
  fakePaystack.planAmounts.set(PLAN.CELEBRATE_ANNUAL, SUBSCRIPTION_PRICES_CENTS.CELEBRATE.ANNUAL);
  fakePaystack.planAmounts.set(PLAN.ELEVATE_MONTHLY, SUBSCRIPTION_PRICES_CENTS.ELEVATE.MONTHLY);
  fakePaystack.planAmounts.set(PLAN.ELEVATE_ANNUAL, SUBSCRIPTION_PRICES_CENTS.ELEVATE.ANNUAL);
};

export interface PaymentsActor {
  id: string;
  firebaseUid: string;
  email: string;
  role: 'TENANT_ADMIN' | 'SUPER_ADMIN';
  tenantId: string | null;
}

export interface PaymentsTenant {
  tenantId: string;
  email: string;
  admin: PaymentsActor;
  eventId: string;
}

const tokens = new Map<string, string>();

export const installAuth = (): void => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
};

export const headersFor = (actor: PaymentsActor) => {
  const firebaseToken = `payments-${actor.id}`;
  tokens.set(firebaseToken, actor.firebaseUid);
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

const createUser = async (role: 'TENANT_ADMIN' | 'SUPER_ADMIN', tenantId: string | null): Promise<PaymentsActor> => {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      firebaseUid: `payments-uid-${suffix}`,
      email: `payments-user-${suffix}@test.invalid`,
      username: `payments-${suffix}`,
      role,
      tenantId,
      isActive: true,
      isArchived: false,
      ...termsAcceptedUnless(false),
    },
  });
  return { id: user.id, firebaseUid: user.firebaseUid, email: user.email, role, tenantId };
};

const createdTenants: PaymentsTenant[] = [];
const createdSuperAdmins: PaymentsActor[] = [];

export const createPaymentsTenant = async (): Promise<PaymentsTenant> => {
  const suffix = randomUUID();
  const email = `billing-${suffix}@payments.test`;
  const tenant = await prisma.tenant.create({
    data: { name: `Payments Tenant ${suffix}`, slug: `payments-${suffix}`, email, subscriptionTier: 'SPARK', subscriptionStatus: 'ACTIVE', isArchived: false },
  });
  const admin = await createUser('TENANT_ADMIN', tenant.id);
  const event = await createTestEvent(tenant.id, admin.id);
  const created = { tenantId: tenant.id, email, admin, eventId: event.id };
  createdTenants.push(created);
  return created;
};

export const createSuperAdmin = async (): Promise<PaymentsActor> => {
  const actor = await createUser('SUPER_ADMIN', null);
  createdSuperAdmins.push(actor);
  return actor;
};

// The payment alert emails sent so far (to the alert address).
export const paymentAlerts = () => sentEmails().filter((e) => e.subject.startsWith('[e-velope payments]'));

export const cleanupPayments = async (): Promise<void> => {
  const tenantIds = createdTenants.map((t) => t.tenantId);
  const eventIds = createdTenants.map((t) => t.eventId);
  const passRefs = (await prisma.eventPassPurchase.findMany({ where: { tenantId: { in: tenantIds } }, select: { paymentRef: true } }))
    .flatMap((p) => (p.paymentRef ? [p.paymentRef] : []));
  const bundleRefs = (await prisma.eventSmsBundlePurchase.findMany({ where: { tenantId: { in: tenantIds } }, select: { paymentRef: true } }))
    .flatMap((p) => (p.paymentRef ? [p.paymentRef] : []));
  const refs = [...passRefs, ...bundleRefs, ...trackedReferences, ...sentWebhookIds];

  await prisma.paymentLedgerEntry.deleteMany({
    where: { OR: [{ tenantId: { in: tenantIds } }, { eventId: { in: eventIds } }, { paystackReference: { in: refs } }] },
  });
  await prisma.paymentMismatch.deleteMany({
    where: { OR: [{ tenantId: { in: tenantIds } }, { paystackReference: { in: refs } }] },
  });
  await prisma.paystackWebhookEvent.deleteMany({ where: { dedupeKey: { in: sentWebhookKeys } } });
  await prisma.eventPassPurchase.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.eventPass.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.eventSmsBundlePurchase.deleteMany({ where: { tenantId: { in: tenantIds } } });
  for (const t of createdTenants) {
    await deleteTestEvent(t.eventId);
    await prisma.user.delete({ where: { id: t.admin.id } });
    await prisma.tenant.delete({ where: { id: t.tenantId } });
  }
  for (const a of createdSuperAdmins) await prisma.user.delete({ where: { id: a.id } });
  createdTenants.length = 0;
  createdSuperAdmins.length = 0;
};

// References used outside a purchase row (a subscribe attempt), for cleanup.
export const trackedReferences: string[] = [];
