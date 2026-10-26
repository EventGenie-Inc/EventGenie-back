import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import prisma from '../../src/shared/prisma/prisma.client.js';
import {
  TENANT_SLUG_INVALID,
  TENANT_SLUG_INVALID_MESSAGE,
  TENANT_SLUG_MAX_CHARS,
  resolveBaseSlug,
  slugCandidate,
} from '../../src/modules/auth/tenant-slug.util.js';

// ─────────────────────────────────────────
//  THE ORGANISATION ADDRESS (Tenant.slug) AT SIGN-UP — POST /api/auth/register
//
//  Optional: blank or missing is made from the organisation's name. A taken
//  address (the typed one or the made one) becomes the next free one,
//  name-2, name-3, ... instead of a refusal. A typed address that isn't
//  valid is 422 TENANT_SLUG_INVALID, and nothing is created.
// ─────────────────────────────────────────

const createdTenantIds: string[] = [];

afterAll(async () => {
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => ({ uid: token, email: `${token}@test.invalid` }));
});

// Unique per test run, so earlier runs' tenants never collide.
const runTag = () => randomUUID().slice(0, 8);

const register = async (body: Record<string, unknown>) => {
  const res = await request(app)
    .post('/api/auth/register')
    .set('Authorization', `Bearer register-slug-${randomUUID()}`)
    .send({ username: 'New Owner', ...body });
  if (res.status === 201) createdTenantIds.push(res.body.data.tenant.id);
  return res;
};

// Somebody else's tenant already holding an address.
const takeSlug = async (slug: string) => {
  const tenant = await prisma.tenant.create({
    data: { name: 'Already here', slug, email: `taken-${randomUUID()}@test.invalid`, subscriptionTier: 'SPARK', subscriptionStatus: 'ACTIVE' },
  });
  createdTenantIds.push(tenant.id);
};

describe('POST /api/auth/register — the organisation address', () => {
  it('blank or missing: made from the name', async () => {
    const tag = runTag();
    for (const [label, slugField] of [
      ['missing', {}],
      ['empty', { tenantSlug: '' }],
      ['spaces', { tenantSlug: '   ' }],
      ['null', { tenantSlug: null }],
    ] as const) {
      const res = await register({ tenantName: `Sarah & Tom ${tag} ${label}`, ...slugField });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.tenant.slug).toBe(`sarah-tom-${tag}-${label}`);
    }
  }, 60000);

  it('a made address that is taken becomes name-2, then name-3', async () => {
    const tag = runTag();
    const name = `Acme HR ${tag}`;
    const first = await register({ tenantName: name });
    const second = await register({ tenantName: name });
    const third = await register({ tenantName: name });
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
    expect(first.body.data.tenant.slug).toBe(`acme-hr-${tag}`);
    expect(second.body.data.tenant.slug).toBe(`acme-hr-${tag}-2`);
    expect(third.body.data.tenant.slug).toBe(`acme-hr-${tag}-3`);
  }, 60000);

  it('a typed address that is taken becomes the next free one, skipping any taken further on', async () => {
    const slug = `wedding-${runTag()}`;
    await takeSlug(slug);
    await takeSlug(`${slug}-2`);
    const res = await register({ tenantName: 'Anything', tenantSlug: slug });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.tenant.slug).toBe(`${slug}-3`);
  }, 60000);

  it('a typed address that is free is used as typed (trimmed, lowercased)', async () => {
    const slug = `typed-${runTag()}`;
    const res = await register({ tenantName: 'Unrelated Name', tenantSlug: `  ${slug.toUpperCase()} ` });
    expect(res.status).toBe(201);
    expect(res.body.data.tenant.slug).toBe(slug);
  }, 60000);

  it('a typed address that is not valid: 422 TENANT_SLUG_INVALID, nothing created', async () => {
    const tag = runTag();
    for (const tenantSlug of ['sarah & tom', 'sarah--tom', '-sarah', 'sarah-', 'ünïcode', 'a'.repeat(TENANT_SLUG_MAX_CHARS + 1)]) {
      const tenantName = `Invalid ${tag}`;
      const res = await register({ tenantName, tenantSlug });
      expect(res.status, tenantSlug).toBe(422);
      expect(res.body).toEqual({ status: 'error', message: TENANT_SLUG_INVALID_MESSAGE, code: TENANT_SLUG_INVALID });
      expect(await prisma.tenant.count({ where: { name: tenantName } })).toBe(0);
    }
  }, 60000);

  it('a typed address that is not text is a 400', async () => {
    const res = await register({ tenantName: `Number ${runTag()}`, tenantSlug: 42 });
    expect(res.status).toBe(400);
  }, 60000);

  it('the organisation name is still required', async () => {
    expect((await register({ tenantName: '  ', tenantSlug: `x-${runTag()}` })).status).toBe(400);
  }, 60000);
});

describe('tenant-slug.util', () => {
  it('makes an address from a name: accents dropped, symbols to single hyphens, capped', () => {
    expect(resolveBaseSlug(undefined, '  Café Ünïque & Co.  ')).toBe('cafe-unique-co');
    expect(resolveBaseSlug('', '!!!')).toBe('organisation');
    expect(resolveBaseSlug(null, 'x'.repeat(100))).toHaveLength(TENANT_SLUG_MAX_CHARS);
  });

  it('a suffix never takes an address past the limit, and never leaves a double hyphen', () => {
    // 60 characters; cut to 58 for "-2" it would end in a hyphen.
    const base = `${'a'.repeat(TENANT_SLUG_MAX_CHARS - 3)}-bc`;
    const second = slugCandidate(base, 2);
    expect(second.length).toBeLessThanOrEqual(TENANT_SLUG_MAX_CHARS);
    expect(second).toBe(`${'a'.repeat(TENANT_SLUG_MAX_CHARS - 3)}-2`);
    expect(slugCandidate(base, 1)).toBe(base);
    expect(slugCandidate('acme', 12)).toBe('acme-12');
  });
});
