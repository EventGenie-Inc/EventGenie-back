import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  MEMORY HUB LIMITS ABOVE 2 GB, AND THE TIER ADMIN'S TWO NEW FIELDS
//
//  maxMemoryHubBytesPerEvent is a BIGINT column, handed to the code as a
//  plain number: a Super Admin can set 5 GB, every response carrying the
//  config still serialises, /me reports it, and an event holding more than
//  2^31 bytes reports what it uses against it. The tier admin endpoints
//  take maxMemoryHubBytesPerEvent and guestExportEnabled, and refuse
//  values the columns can't hold with a 422 instead of a 500.
// ─────────────────────────────────────────

const FIVE_GB = 5 * 1024 * 1024 * 1024; // 5,368,709,120 — past an int4
const tenantIds: string[] = [];
let savedElevate: SubscriptionTierConfig | null = null;
let superAdmin: Actor;
let organiser: Actor;
let eventId: string;

beforeAll(async () => {
  savedElevate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'ELEVATE' },
    create: { tier: 'ELEVATE', memoryHubEnabled: true },
    update: { memoryHubEnabled: true },
  });
  const tenant = await createTenant(); // ELEVATE
  tenantIds.push(tenant.id);
  superAdmin = await createActor('SUPER_ADMIN', null);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventId = (await createEventWithDay(tenant.id, organiser.id)).event.id;
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await prisma.memoryItem.deleteMany({ where: { memoryHub: { eventId } } });
  await deleteTenantsDeep(tenantIds.splice(0));
  await prisma.user.delete({ where: { id: superAdmin.id } });
  if (savedElevate) {
    // The whole saved row, updatedAt included: back exactly as found.
    const { tier: _tier, ...values } = savedElevate;
    await prisma.subscriptionTierConfig.upsert({ where: { tier: 'ELEVATE' }, create: savedElevate, update: values });
  } else {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'ELEVATE' } });
  }
  await prisma.$disconnect();
}, 60000);

const putTier = (body: Record<string, unknown>) =>
  request(app).put('/api/subscription-tiers/ELEVATE').set(headersFor(superAdmin)).send(body);

describe('a Memory Hub limit above 2 GB', () => {
  it('is saved and returned as a plain number by every response that carries it', async () => {
    const saved = await putTier({ maxMemoryHubBytesPerEvent: FIVE_GB, guestExportEnabled: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ maxMemoryHubBytesPerEvent: FIVE_GB, guestExportEnabled: true });

    const row = await prisma.subscriptionTierConfig.findUniqueOrThrow({ where: { tier: 'ELEVATE' } });
    expect(row.maxMemoryHubBytesPerEvent).toBe(BigInt(FIVE_GB));

    const list = await request(app).get('/api/subscription-tiers').set(headersFor(superAdmin));
    expect(list.status).toBe(200);
    expect(list.body.data.find((c: { tier: string }) => c.tier === 'ELEVATE').maxMemoryHubBytesPerEvent).toBe(FIVE_GB);

    const me = await request(app).get('/api/tenants/me').set(headersFor(organiser));
    expect(me.status).toBe(200);
    expect(me.body.data.planSettings).toMatchObject({ maxMemoryHubBytesPerEvent: FIVE_GB, guestExportEnabled: true });
  }, 60000);

  it('an event holding more than 2^31 bytes reports its use against the limit', async () => {
    await putTier({ maxMemoryHubBytesPerEvent: FIVE_GB });
    const hub = await prisma.memoryHub.findFirstOrThrow({ where: { eventId } });
    for (const i of [1, 2]) {
      await prisma.memoryItem.create({
        data: {
          memoryHubId: hub.id,
          uploadedByUserId: organiser.id,
          mediaUrl: `https://res.cloudinary.com/demo/video/upload/big-${i}.mp4`,
          cloudinaryPublicId: `big-${i}`,
          mediaType: 'VIDEO',
          bytes: 1_500_000_000,
          status: 'APPROVED',
          createdBy: organiser.id,
          updatedBy: organiser.id,
        },
      });
    }
    const res = await request(app).get(`/api/events/${eventId}/memory-hub`).set(headersFor(organiser));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ usedBytes: 3_000_000_000, limitBytes: FIVE_GB });
  }, 60000);

  it('null sets it back to unlimited', async () => {
    const res = await putTier({ maxMemoryHubBytesPerEvent: null });
    expect(res.status).toBe(200);
    expect(res.body.data.maxMemoryHubBytesPerEvent).toBeNull();
  }, 60000);
});

describe("the tier admin refuses what the columns can't hold", () => {
  for (const [name, body] of [
    ['a decimal byte count', { maxMemoryHubBytesPerEvent: 1.5 }],
    ['a negative byte count', { maxMemoryHubBytesPerEvent: -1 }],
    ['a byte count as text', { maxMemoryHubBytesPerEvent: '10' }],
    ['a byte count past whole-number precision', { maxMemoryHubBytesPerEvent: 2 ** 60 }],
    ['guest export that is not on or off', { guestExportEnabled: 'yes' }],
  ] as const) {
    it(`${name} is 422, and nothing changes`, async () => {
      const before = await prisma.subscriptionTierConfig.findUniqueOrThrow({ where: { tier: 'ELEVATE' } });
      const res = await putTier(body);
      expect(res.status).toBe(422);
      const after = await prisma.subscriptionTierConfig.findUniqueOrThrow({ where: { tier: 'ELEVATE' } });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    }, 60000);
  }
});
