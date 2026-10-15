import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import { assertEventCreatable, assertEventUpdatable } from '../../src/modules/subscription-tier-config/event-tier-enforcement.util.js';
import { assertGuestsCreatable } from '../../src/modules/subscription-tier-config/guest-tier-enforcement.util.js';
import { assertGuestExportEnabled } from '../../src/modules/subscription-tier-config/guest-export-tier-enforcement.util.js';
import { assertSmsSendable } from '../../src/modules/subscription-tier-config/sms-tier-enforcement.util.js';
import { assertMemoryHubAccessible, assertMemoryHubQuotaAvailable } from '../../src/modules/memory-hub/memory-hub-tier-enforcement.util.js';
import { memoryHubService } from '../../src/modules/memory-hub/memory-hub.service.js';
import { memoryHubRepository } from '../../src/modules/memory-hub/memory-hub.repository.js';
import { memoryHubFolder } from '../../src/modules/upload/upload-folders.js';
import {
  assertVendorSpaceCreatable,
  assertVendorMarketplaceAccessible,
  assertEventVendorMarketplaceAccessible,
} from '../../src/modules/vendor/vendor-tier-enforcement.util.js';
import { assertTenantReadyToSellTickets, assertEventReadyToSellTickets } from '../../src/modules/payment-account/payment-account-readiness.util.js';
import { HttpError } from '../../src/shared/errors/http-error.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createPublicEvent, cleanupPublicEventFixtures } from '../public-events/helpers.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  FREE PILOT — with `payments` off nobody can pay, so no tier refusal may
//  point anyone at a plan, an upgrade, a pass or a price. Every
//  organiser-facing tier refusal is called here with payments off: its
//  status (and code, where it has one) is unchanged, and its message has
//  none of that language and gives the launch contact instead. With
//  payments on, the same refusal still names the plan (the flag is what
//  changes the wording).
//
//  The test database holds no tier configs unless a test writes them; this
//  file sets the rows it needs and puts every tier back as it found it.
// ─────────────────────────────────────────

vi.mock('../../src/shared/cloudinary/cloudinary.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/cloudinary/cloudinary.client.js')>();
  return { ...actual, destroyAsset: vi.fn(async () => ({ ok: true })) };
});

// Plan, tier and pass names, upgrading, buying, subscriptions and prices.
const PLAN_WORDING = /plan|upgrad|spark|celebrate|elevate|\bpass\b|\bbuy\b|subscri|pric|\bR\s?\d/i;
const LAUNCH_WORDING = /during our launch period.*admin@e-velope\.co\.za/s;

const TIERS: SubscriptionTier[] = ['SPARK', 'CELEBRATE', 'ELEVATE'];
let savedConfigs: SubscriptionTierConfig[] = [];

const BASE_CONFIG = {
  maxEvents: null,
  maxGuestsPerEvent: null,
  maxSmsPerMonth: null,
  maxVendorSpaces: null,
  maxMemoryHubBytesPerEvent: null,
  emailEnabled: true,
  smsEnabled: false,
  vendorMarketplace: false,
  memoryHubEnabled: false,
  dragDropBuilder: false,
  guestExportEnabled: false,
  publicEventsEnabled: false,
  paidTicketingEnabled: false,
  customRsvpFieldsEnabled: false,
  vendorPriorityPlacement: false,
};

const setConfig = (tier: SubscriptionTier, values: Partial<typeof BASE_CONFIG>) =>
  prisma.subscriptionTierConfig.upsert({
    where: { tier },
    create: { tier, ...BASE_CONFIG, ...values },
    update: { ...BASE_CONFIG, ...values },
  });

let tenantId: string;
let userId: string;
let realEventId: string;

// An event as the event-scoped checks see it; no pass unless given one.
const eventFor = (overrides: Partial<{ eventPass: { passTier: 'SMALL' } | null }> = {}) => ({
  id: randomUUID(),
  tenantId,
  eventPass: null,
  eventDays: [],
  ...overrides,
});

beforeAll(async () => {
  savedConfigs = await prisma.subscriptionTierConfig.findMany();
  tenantId = (await createTestTenant()).id; // SPARK
  const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
  userId = user.id;
  realEventId = (await createTestEvent(tenantId, userId)).id;
}, 60000);

afterAll(async () => {
  await prisma.memoryItem.deleteMany({ where: { memoryHub: { eventId: realEventId } } });
  await deleteTestEvent(realEventId);
  await deleteTestUserRow(userId);
  await deleteTestTenant(tenantId);
  for (const tier of TIERS) {
    const saved = savedConfigs.find((c) => c.tier === tier);
    if (saved) {
      const { tier: _tier, updatedAt: _updatedAt, ...values } = saved;
      await prisma.subscriptionTierConfig.update({ where: { tier }, data: values });
    } else {
      await prisma.subscriptionTierConfig.deleteMany({ where: { tier } });
    }
  }
}, 60000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPublicEventFixtures();
});

const refusalOf = async (fn: () => Promise<unknown>): Promise<HttpError> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal, but the call succeeded');
};

// Runs the refusal with payments off (launch wording) and on (plan
// wording), checking the status is the same both ways.
const expectLaunchWording = async (status: number, fn: () => Promise<unknown>) => {
  vi.stubEnv('FEATURES_DISABLED', 'payments');
  const off = await refusalOf(fn);
  expect(off.statusCode).toBe(status);
  expect(off.message).not.toMatch(PLAN_WORDING);
  expect(off.message).toMatch(LAUNCH_WORDING);

  vi.stubEnv('FEATURES_DISABLED', '');
  const on = await refusalOf(fn);
  expect(on.statusCode).toBe(status);
  expect(on.message).toMatch(PLAN_WORDING);
  return off;
};

describe('payments off — every tier refusal is worded without plans, upgrades or prices', () => {
  it('events: the active-event limit, public events, paid ticketing and custom RSVP questions', async () => {
    await setConfig('SPARK', { maxEvents: 0 });
    await expectLaunchWording(403, () => assertEventCreatable(tenantId, {}));

    await setConfig('SPARK', {});
    // The verb and pronoun agree with the feature's name: plural names
    // "aren't … them", singular ones "isn't … it".
    const publicEvents = await expectLaunchWording(403, () => assertEventCreatable(tenantId, { visibility: 'PUBLIC' }));
    expect(publicEvents.message).toBe(
      "Public events aren't available on your account during our launch period. Contact us at admin@e-velope.co.za if you need them."
    );
    const paidTicketing = await expectLaunchWording(403, () => assertEventCreatable(tenantId, { ticketing: 'PAID' }));
    expect(paidTicketing.message).toBe(
      "Paid ticketing isn't available on your account during our launch period. Contact us at admin@e-velope.co.za if you need it."
    );
    const customQuestions = await expectLaunchWording(403, () => assertEventUpdatable(eventFor(), { hasCustomRsvpFields: true }));
    expect(customQuestions.message).toBe(
      "Custom RSVP questions aren't available on your account during our launch period. Contact us at admin@e-velope.co.za if you need them."
    );
  }, 60000);

  it('the guest limit (with its counts still given)', async () => {
    await setConfig('SPARK', { maxGuestsPerEvent: 0 });
    const off = await expectLaunchWording(403, () => assertGuestsCreatable(eventFor(), 3));
    expect(off.message).toMatch(/limit of 0 guest\(s\) for this event/);
    expect(off.message).toMatch(/this would add 3 more/);
  }, 60000);

  it('guest list export', async () => {
    await setConfig('SPARK', {});
    await expectLaunchWording(403, () => assertGuestExportEnabled(eventFor()));
  }, 60000);

  it('SMS: not on the account, the monthly allowance, and an event’s bundle', async () => {
    await setConfig('SPARK', {});
    await expectLaunchWording(403, () => assertSmsSendable(eventFor(), 2, 'invite'));
    await expectLaunchWording(403, () => assertSmsSendable(eventFor(), 2, 'reminder'));

    await setConfig('SPARK', { smsEnabled: true, maxSmsPerMonth: 0 });
    await expectLaunchWording(403, () => assertSmsSendable(eventFor(), 2, 'invite'));
    await expectLaunchWording(403, () => assertSmsSendable(eventFor(), 2, 'reminder'));

    // An event with a pass draws on its own bundle, which holds nothing here.
    await setConfig('CELEBRATE', { smsEnabled: true });
    await expectLaunchWording(403, () => assertSmsSendable(eventFor({ eventPass: { passTier: 'SMALL' } }), 2));
  }, 60000);

  it('Memory Hub: not on the account, the storage limit before upload, and an upload that would pass it', async () => {
    await setConfig('SPARK', {});
    await expectLaunchWording(403, () => assertMemoryHubAccessible(eventFor()));

    await setConfig('SPARK', { memoryHubEnabled: true, maxMemoryHubBytesPerEvent: 0 });
    await expectLaunchWording(403, () => assertMemoryHubQuotaAvailable(eventFor()));

    // The persist-time check, with a real signed upload in this event's folder.
    await setConfig('SPARK', { memoryHubEnabled: true, maxMemoryHubBytesPerEvent: 1000 });
    const hub = await memoryHubRepository.findByEventId(realEventId);
    const publicId = `${memoryHubFolder(tenantId, realEventId)}/${randomUUID()}`;
    const mediaUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/v1/${publicId}.jpg`;
    await expectLaunchWording(403, () =>
      memoryHubService.createOrganiserItem(hub!.id, userId, 'SUPER_ADMIN', null, {
        mediaUrl,
        cloudinaryPublicId: publicId,
        mediaType: 'IMAGE',
        bytes: 5000,
      })
    );
  }, 60000);

  it('vendors: the marketplace (as a vendor, a searcher and for an event) and the vendor space limit', async () => {
    await setConfig('SPARK', {});
    await expectLaunchWording(403, () => assertVendorSpaceCreatable(tenantId));
    await expectLaunchWording(403, () => assertVendorMarketplaceAccessible(tenantId));
    await expectLaunchWording(403, () => assertEventVendorMarketplaceAccessible(eventFor()));

    await setConfig('SPARK', { vendorMarketplace: true, maxVendorSpaces: 0 });
    await expectLaunchWording(403, () => assertVendorSpaceCreatable(tenantId));
  }, 60000);

  it('paid ticketing on the payout side', async () => {
    await setConfig('SPARK', {});
    await expectLaunchWording(403, () => assertTenantReadyToSellTickets(tenantId));
    await expectLaunchWording(403, () => assertEventReadyToSellTickets(eventFor()));
  }, 60000);

  it('the registration cap above the guest limit keeps its status and code', async () => {
    installFirebaseMock();
    await setConfig('SPARK', { maxGuestsPerEvent: 100 });
    const ev = await createPublicEvent();
    await prisma.tenant.update({ where: { id: ev.tenantId }, data: { subscriptionTier: 'SPARK' } });
    const put = () =>
      request(app).put(`/api/events/${ev.eventId}/registration-settings`).set(headersFor(ev.organiser)).send({ cap: 101 });

    vi.stubEnv('FEATURES_DISABLED', 'payments');
    const off = await put();
    expect(off.status).toBe(422);
    expect(off.body.code).toBe('REGISTRATION_SETTINGS_CAP_ABOVE_PLAN_LIMIT');
    expect(off.body.message).not.toMatch(PLAN_WORDING);
    expect(off.body.message).toMatch(LAUNCH_WORDING);
    expect(off.body.message).toMatch(/at most 100/);

    vi.stubEnv('FEATURES_DISABLED', '');
    const on = await put();
    expect(on.status).toBe(422);
    expect(on.body.code).toBe('REGISTRATION_SETTINGS_CAP_ABOVE_PLAN_LIMIT');
    expect(on.body.message).toMatch(PLAN_WORDING);
  }, 60000);
});
