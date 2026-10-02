import { randomUUID } from 'crypto';
import prisma from '../../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  Test fixtures — real Postgres rows on DATABASE_URL_TEST (see
//  tests/setup.ts and prisma.client.ts's own refusal guard), created
//  directly via Prisma rather than through the HTTP register/verify-otp
//  flow. That flow's job — Firebase sign-up, OTP delivery via Resend —
//  is out of scope for this suite (only firebase-admin/auth's
//  verifyIdToken is stubbed; Resend is not, and isn't needed for what
//  Part 1 tests). A fixture only needs a real Postgres User whose
//  firebaseUid matches whatever tests/setup.ts's mockVerifyIdToken is
//  told to resolve for a given test.
// ─────────────────────────────────────────

export interface TestUser {
  id: string;
  tenantId: string;
  firebaseUid: string;
  email: string;
}

export const createTestTenantAndUser = async (
  opts: { role?: 'TENANT_ADMIN' | 'EVENT_ADMIN' | 'EVENT_VENDOR'; isActive?: boolean; isArchived?: boolean } = {}
): Promise<TestUser> => {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      name: `Auth Harness Tenant ${suffix}`,
      slug: `auth-harness-${suffix}`,
      email: `auth-harness-${suffix}@test.invalid`,
      subscriptionTier: 'SPARK',
      subscriptionStatus: 'ACTIVE',
      isArchived: false,
    },
  });

  const firebaseUid = `test-firebase-uid-${suffix}`;
  const user = await prisma.user.create({
    data: {
      firebaseUid,
      email: `auth-harness-${suffix}@test.invalid`,
      username: `auth-harness-${suffix}`,
      role: opts.role ?? 'TENANT_ADMIN',
      tenantId: tenant.id,
      isActive: opts.isActive ?? true,
      isArchived: opts.isArchived ?? false,
    },
  });

  return { id: user.id, tenantId: tenant.id, firebaseUid, email: user.email };
};

// Hard delete — deliberately NOT the app's own archive()/soft-delete
// path. These rows never existed from the product's point of view; they
// are fixtures on an isolated test database, not real tenant data
// STEERING's soft-delete rule protects. Device tokens cascade via the
// FK's ON DELETE RESTRICT... — actually RESTRICT would block this, so
// device tokens are deleted explicitly first.
export const deleteTestTenantAndUser = async (user: TestUser): Promise<void> => {
  await prisma.deviceToken.deleteMany({ where: { userId: user.id } });
  await prisma.otpRecord.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.tenant.delete({ where: { id: user.tenantId } });
};

export { prisma };
