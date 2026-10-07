import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import prisma from '../../src/shared/prisma/prisma.client.js';
import { subscriptionService } from '../../src/modules/subscription/subscription.service.js';

// ─────────────────────────────────────────
//  Tenant emails (Team Members follow-ups): Paystack's subscription
//  webhooks name the tenant only by its billing email, in whatever case
//  Paystack holds it. The lookup compares normalised forms on both sides,
//  refuses an address two tenants share once normalised, and the
//  lowercase_tenant_emails migration normalises stored rows, skipping
//  collisions.
// ─────────────────────────────────────────

const createdTenantIds: string[] = [];

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
}, 60000);

const createTenant = async (email: string) => {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: { name: `Lookup ${suffix}`, slug: `lookup-${suffix}`, email, subscriptionTier: 'CELEBRATE', subscriptionStatus: 'ACTIVE' },
  });
  createdTenantIds.push(tenant.id);
  return tenant;
};

// subscription.disable: the simplest webhook that finds its tenant by
// customer email and records something on it.
const disableFor = (email: string) =>
  prisma.$transaction((tx) => subscriptionService.handleSubscriptionDisableWithinTransaction(tx, { customer: { email } }));

describe('Paystack subscription lookup by customer email', () => {
  it('a mixed-case, padded Paystack email still finds its (lowercase) tenant', async () => {
    const tag = randomUUID().slice(0, 8);
    const tenant = await createTenant(`billing-${tag}@acme.test`);

    const result = await disableFor(`  Billing-${tag}@ACME.Test `);
    expect(result).toEqual({ claimed: true });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).subscriptionCancelAtPeriodEnd).toBe(true);
  }, 60000);

  it('a stored mixed-case, padded email (from before the rule) still matches a lowercase Paystack email', async () => {
    const tag = randomUUID().slice(0, 8);
    const tenant = await createTenant(`  Legacy-${tag}@Acme.test `);

    expect(await disableFor(`legacy-${tag}@acme.test`)).toEqual({ claimed: true });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).subscriptionCancelAtPeriodEnd).toBe(true);
  }, 60000);

  it('two tenants sharing an address once normalised: neither is matched', async () => {
    const tag = randomUUID().slice(0, 8);
    const a = await createTenant(`Shared-${tag}@acme.test`);
    const b = await createTenant(`shared-${tag}@acme.test`);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await disableFor(`shared-${tag}@acme.test`)).toEqual({ claimed: false });
    vi.restoreAllMocks();
    for (const id of [a.id, b.id]) {
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).subscriptionCancelAtPeriodEnd).toBe(false);
    }
  }, 60000);
});

describe('the lowercase_tenant_emails migration', () => {
  it('lowercases and trims tenant emails, and skips both rows of a collision', async () => {
    const tag = randomUUID().slice(0, 8);
    const plain = await createTenant(` Plain-${tag}@X.TEST `);
    const dupUpper = await createTenant(`Dup-${tag}@x.test`);
    const dupLower = await createTenant(`dup-${tag}@x.test`);

    const sql = readFileSync('prisma/migrations/20261007090000_lowercase_tenant_emails/migration.sql', 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    const email = async (id: string) => (await prisma.tenant.findUniqueOrThrow({ where: { id } })).email;
    expect(await email(plain.id)).toBe(`plain-${tag}@x.test`);
    expect(await email(dupUpper.id)).toBe(`Dup-${tag}@x.test`);
    expect(await email(dupLower.id)).toBe(`dup-${tag}@x.test`);
  }, 60000);
});
