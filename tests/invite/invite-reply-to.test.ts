import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { resolveReplyTo } from '../../src/modules/invite/invite-dispatch.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  AN INVITATION'S REPLY-TO ALWAYS REACHES SOMEONE
//
//  Replies to an invitation go to the event's creator. When the creator is
//  archived or suspended: the tenant's longest-serving active TENANT_ADMIN;
//  when there is none: EMAIL_FALLBACK_REPLY_TO from config. Never the
//  no-reply sender address.
// ─────────────────────────────────────────

const FALLBACK = 'fallback-admin@sender.example.test';
const savedFallback = process.env.EMAIL_FALLBACK_REPLY_TO;

let tenantId: string;
let creator: { id: string; email: string };
const extraUserIds: string[] = [];

beforeAll(async () => {
  process.env.EMAIL_FALLBACK_REPLY_TO = FALLBACK;
  tenantId = (await createTestTenant()).id;
  creator = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId });
}, 60000);

afterEach(async () => {
  await prisma.user.update({ where: { id: creator.id }, data: { isArchived: false, isActive: true } });
});

afterAll(async () => {
  if (savedFallback === undefined) delete process.env.EMAIL_FALLBACK_REPLY_TO;
  else process.env.EMAIL_FALLBACK_REPLY_TO = savedFallback;
  for (const id of [...extraUserIds, creator.id]) await deleteTestUserRow(id);
  await deleteTestTenant(tenantId);
  await prisma.$disconnect();
}, 60000);

const event = () => ({ tenantId, createdByUserId: creator.id });

describe('resolveReplyTo', () => {
  it('is the creator while they are active', async () => {
    expect(await resolveReplyTo(event())).toBe(creator.email);
  });

  it('falls back to config when the creator is archived and the tenant has no active admin', async () => {
    await prisma.user.update({ where: { id: creator.id }, data: { isArchived: true } });
    // Admins that don't count: another tenant's, an archived one, a suspended one.
    const otherTenantId = (await createTestTenant()).id;
    const elsewhere = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: otherTenantId });
    const archived = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
    const suspended = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
    await prisma.user.update({ where: { id: archived.id }, data: { isArchived: true } });
    await prisma.user.update({ where: { id: suspended.id }, data: { isActive: false } });
    try {
      expect(await resolveReplyTo(event())).toBe(FALLBACK);
    } finally {
      await deleteTestUserRow(elsewhere.id);
      await deleteTestTenant(otherTenantId);
      extraUserIds.push(archived.id, suspended.id);
    }
  }, 60000);

  it('falls back to the tenant\'s longest-serving active TENANT_ADMIN when the creator is archived', async () => {
    const first = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
    const second = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
    await prisma.user.update({ where: { id: first.id }, data: { createdAt: new Date('2020-01-01') } });
    extraUserIds.push(first.id, second.id);

    await prisma.user.update({ where: { id: creator.id }, data: { isArchived: true } });
    expect(await resolveReplyTo(event())).toBe(first.email);

    // A suspended (not archived) creator is no better.
    await prisma.user.update({ where: { id: creator.id }, data: { isArchived: false, isActive: false } });
    expect(await resolveReplyTo(event())).toBe(first.email);
  }, 60000);

  it('is null (and logged) only when even the config is missing', async () => {
    await prisma.user.update({ where: { id: creator.id }, data: { isArchived: true } });
    await prisma.user.updateMany({ where: { tenantId, role: 'TENANT_ADMIN' }, data: { isActive: false } });
    delete process.env.EMAIL_FALLBACK_REPLY_TO;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await resolveReplyTo(event())).toBeNull();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      process.env.EMAIL_FALLBACK_REPLY_TO = FALLBACK;
      await prisma.user.updateMany({ where: { tenantId, role: 'TENANT_ADMIN' }, data: { isActive: true } });
    }
  }, 60000);
});
