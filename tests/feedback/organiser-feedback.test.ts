import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';

// destroyAsset is the one Cloudinary call these paths make (an oversized
// logo); mocked to observe it and so nothing real is ever deleted.
const { mockDestroyAsset } = vi.hoisted(() => ({ mockDestroyAsset: vi.fn() }));
vi.mock('../../src/shared/cloudinary/cloudinary.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/cloudinary/cloudinary.client.js')>()),
  destroyAsset: mockDestroyAsset,
}));

import app from '../../src/app.js';
import { assign, createActor, createTenant, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { feedbackLogoFolder } from '../../src/modules/upload/upload-folders.js';
import { FEEDBACK_LOGO_MAX_BYTES } from '../../src/modules/upload/upload-constants.js';
import { addPhoto, cleanupTenants, deliveryUrl, newEvent, newGuest, setGuestSharing } from './helpers.js';

// ─────────────────────────────────────────
//  ORGANISER FEEDBACK — /api/events/:eventId/feedback
//
//  One feedback per event, given once the event is COMPLETED, by its
//  organisers (tenant-scoped, under the assignment lock). Each permission
//  is a consent record, only changes recorded. A photo can be selected only
//  while it is approved, live, and its guest has opted in. The logo is
//  checked like every other client-supplied Cloudinary asset.
// ─────────────────────────────────────────

// Each PUT is about twenty round trips to the remote test database.
vi.setConfig({ testTimeout: 90_000 });

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let otherTenantAdmin: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  const other = await createTenant();
  tenantIds.push(tenant.id, other.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  otherTenantAdmin = await createActor('TENANT_ADMIN', other.id);
}, 60000);

beforeEach(() => {
  installFirebaseMock();
  mockDestroyAsset.mockReset();
  mockDestroyAsset.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await cleanupTenants(tenantIds.splice(0));
}, 120000);

const get = (eventId: string, actor: Actor = organiser) => request(app).get(`/api/events/${eventId}/feedback`).set(headersFor(actor));
const put = (eventId: string, body: unknown, actor: Actor = organiser) =>
  request(app).put(`/api/events/${eventId}/feedback`).set(headersFor(actor)).send(body as object);

const consents = (eventId: string) => prisma.consentRecord.findMany({ where: { eventId }, orderBy: { seq: 'asc' } });

describe('only once the event has taken place', () => {
  it('a future, draft or cancelled event is 422 FEEDBACK_EVENT_NOT_COMPLETED with nothing saved; a completed one saves', async () => {
    const future = await newEvent(tenantId, organiser.id, { daysAgo: -30 });
    const draft = await newEvent(tenantId, organiser.id, { status: 'DRAFT' });
    const cancelled = await newEvent(tenantId, organiser.id, { status: 'CANCELLED' });
    for (const { event } of [future, draft, cancelled]) {
      const res = await put(event.id, { score: 9, permissions: { QUOTE: true } });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FEEDBACK_EVENT_NOT_COMPLETED');
      expect(await prisma.eventFeedback.count({ where: { eventId: event.id } })).toBe(0);
      expect(await consents(event.id)).toEqual([]);
    }
    expect((await get(future.event.id)).body.data).toMatchObject({ available: false, eventStatus: 'PUBLISHED', feedback: null });

    const done = await newEvent(tenantId, organiser.id);
    const res = await put(done.event.id, { score: 9 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: true, eventStatus: 'COMPLETED', feedback: { score: 9, workedBest: null, toImprove: null } });
  });
});

describe('the answers', () => {
  it('score is required the first time and must be a whole number from 0 to 10', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    for (const body of [{}, { score: 11 }, { score: -1 }, { score: 3.5 }, { score: null }]) {
      const res = await put(event.id, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FEEDBACK_SCORE_INVALID');
    }
    expect((await put(event.id, { score: '7' })).status).toBe(400);
    expect(await prisma.eventFeedback.count({ where: { eventId: event.id } })).toBe(0);
    expect((await put(event.id, { score: 0 })).status).toBe(200);
  });

  it('each answer up to 2000 characters, trimmed, blank stored as null; editing keeps what is left out', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const long = (n: number) => 'a'.repeat(n);
    const tooLong = await put(event.id, { score: 8, workedBest: long(2001) });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.code).toBe('FEEDBACK_WORKED_BEST_TOO_LONG');
    const tooLong2 = await put(event.id, { score: 8, toImprove: long(2001) });
    expect(tooLong2.body.code).toBe('FEEDBACK_TO_IMPROVE_TOO_LONG');

    const saved = await put(event.id, { score: 8, workedBest: `  ${long(2000)}  `, toImprove: '   ' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.feedback).toMatchObject({ score: 8, workedBest: long(2000), toImprove: null });

    const edited = await put(event.id, { toImprove: 'The guest list import' });
    expect(edited.body.data.feedback).toMatchObject({ score: 8, workedBest: long(2000), toImprove: 'The guest list import' });
    expect(await prisma.eventFeedback.count({ where: { eventId: event.id } })).toBe(1);
  });
});

describe('permissions', () => {
  it('each tick is a consent record by the organiser; only a change is recorded; a withdrawal is a new record', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const first = await put(event.id, { score: 9, permissions: { COMPANY_NAME_LOGO: true, QUOTE: true, CASE_STUDY_CONTACT: false } });
    expect(first.status).toBe(200);
    let rows = await consents(event.id);
    expect(rows.map((r) => [r.kind, r.action, r.userId, r.wordingVersion])).toEqual([
      ['COMPANY_NAME_LOGO', 'GRANTED', organiser.id, 2],
      ['QUOTE', 'GRANTED', organiser.id, 2],
    ]);
    expect(first.body.data.permissions.CASE_STUDY_CONTACT.status).toBe('NOT_GIVEN');

    // The same ticks again: nothing new.
    await put(event.id, { permissions: { COMPANY_NAME_LOGO: true, QUOTE: true } });
    expect(await consents(event.id)).toHaveLength(2);

    const withdrawn = await put(event.id, { permissions: { QUOTE: false } });
    rows = await consents(event.id);
    expect(rows.map((r) => [r.kind, r.action])).toEqual([
      ['COMPANY_NAME_LOGO', 'GRANTED'],
      ['QUOTE', 'GRANTED'],
      ['QUOTE', 'WITHDRAWN'],
    ]);
    expect(withdrawn.body.data.permissions.QUOTE).toEqual({
      status: 'WITHDRAWN',
      granted: false,
      givenAt: rows[1]!.recordedAt.toISOString(),
      wordingVersion: 2,
      withdrawnAt: rows[2]!.recordedAt.toISOString(),
    });
    expect(withdrawn.body.data.permissions.COMPANY_NAME_LOGO.status).toBe('GRANTED');
  });

  it('GET carries the exact wording of every tick', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const res = await get(event.id);
    expect(Object.keys(res.body.data.wording).sort()).toEqual(['CASE_STUDY_CONTACT', 'COMPANY_NAME_LOGO', 'PHOTO_ORGANISER_SELECTED', 'QUOTE']);
    expect(res.body.data.wording.QUOTE).toEqual({
      version: 2,
      text: 'e-velope may quote this feedback, with our name, on its website and social media.',
    });
  });

  it('an unknown permission or a non-boolean is a 400', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    expect((await put(event.id, { score: 5, permissions: { PHOTO_GUEST_PUBLIC_SHARING: true } })).status).toBe(400);
    expect((await put(event.id, { score: 5, permissions: { QUOTE: 'yes' } })).status).toBe(400);
    expect(await consents(event.id)).toEqual([]);
  });
});

describe('photo selection', () => {
  it("a photo without its guest's opt-in can't be selected: 422, and nothing at all is saved", async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const notOptedIn = await addPhoto(ev, { guestId: guest.id });

    const res = await put(ev.event.id, { score: 9, permissions: { QUOTE: true }, selectedPhotoIds: [notOptedIn.id] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FEEDBACK_PHOTO_NOT_ELIGIBLE');
    expect(await prisma.eventFeedback.count({ where: { eventId: ev.event.id } })).toBe(0);
    expect(await consents(ev.event.id)).toEqual([]);

    expect((await get(ev.event.id)).body.data.eligiblePhotos).toEqual([]);
  });

  it('pending, rejected, archived, organiser-uploaded, other-event and unknown photos are refused too, opted in or not', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const otherEv = await newEvent(tenantId, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const { guest: otherGuest } = await newGuest(otherEv.event.id, organiser.id);
    const pending = await addPhoto(ev, { guestId: guest.id, status: 'PENDING' });
    const rejected = await addPhoto(ev, { guestId: guest.id, status: 'REJECTED' });
    const archived = await addPhoto(ev, { guestId: guest.id, isArchived: true });
    const otherEvents = await addPhoto(otherEv, { guestId: otherGuest.id });
    for (const p of [pending, rejected, archived]) await setGuestSharing(ev.event.id, guest.id, p.id, true);
    await setGuestSharing(otherEv.event.id, otherGuest.id, otherEvents.id, true);
    const organisers = await addPhoto(ev, { userId: organiser.id });

    for (const id of [pending.id, rejected.id, archived.id, organisers.id, otherEvents.id, randomUUID()]) {
      const res = await put(ev.event.id, { score: 9, selectedPhotoIds: [id] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FEEDBACK_PHOTO_NOT_ELIGIBLE');
    }
    expect(await consents(ev.event.id)).toHaveLength(3); // only the guests' own opt-ins
  });

  it('an approved photo with the opt-in is eligible and selectable; deselecting is a withdrawal', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const photo = await addPhoto(ev, { guestId: guest.id });
    await setGuestSharing(ev.event.id, guest.id, photo.id, true);

    const before = await get(ev.event.id);
    expect(before.body.data.eligiblePhotos).toEqual([
      expect.objectContaining({ id: photo.id, mediaUrl: photo.mediaUrl, uploaderDisplayName: 'Test', selected: false }),
    ]);

    const selected = await put(ev.event.id, { score: 9, selectedPhotoIds: [photo.id] });
    expect(selected.status).toBe(200);
    expect(selected.body.data.selectedPhotoIds).toEqual([photo.id]);
    expect(selected.body.data.eligiblePhotos[0].selected).toBe(true);

    await put(ev.event.id, { selectedPhotoIds: [] });
    const rows = await prisma.consentRecord.findMany({ where: { kind: 'PHOTO_ORGANISER_SELECTED', memoryItemId: photo.id }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.action, r.userId])).toEqual([['GRANTED', organiser.id], ['WITHDRAWN', organiser.id]]);
  });

  it("a guest withdrawing later drops the photo from the eligible list; the organiser's own selection stands and can be re-sent", async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const photo = await addPhoto(ev, { guestId: guest.id });
    await setGuestSharing(ev.event.id, guest.id, photo.id, true);
    await put(ev.event.id, { score: 9, selectedPhotoIds: [photo.id] });

    await setGuestSharing(ev.event.id, guest.id, photo.id, false);
    const after = await get(ev.event.id);
    expect(after.body.data.eligiblePhotos).toEqual([]);
    expect(after.body.data.selectedPhotoIds).toEqual([photo.id]);
    expect((await put(ev.event.id, { score: 8, selectedPhotoIds: [photo.id] })).status).toBe(200);
  });
});

describe('who may', () => {
  it("another tenant's event is 404 to GET and PUT, and nothing is saved", async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    expect((await get(event.id, otherTenantAdmin)).status).toBe(404);
    expect((await put(event.id, { score: 9, permissions: { QUOTE: true } }, otherTenantAdmin)).status).toBe(404);
    expect(await consents(event.id)).toEqual([]);
  });

  it("a locked member gets 404 on an unassigned event and works on an assigned one", async () => {
    const assigned = await newEvent(tenantId, organiser.id);
    const unassigned = await newEvent(tenantId, organiser.id);
    const member = await createActor('EVENT_ADMIN', tenantId);
    await assign(tenantId, member.id, assigned.event.id, organiser.id);

    expect((await get(unassigned.event.id, member)).status).toBe(404);
    expect((await put(unassigned.event.id, { score: 9 }, member)).status).toBe(404);
    expect(await prisma.eventFeedback.count({ where: { eventId: unassigned.event.id } })).toBe(0);

    expect((await get(assigned.event.id, member)).status).toBe(200);
    expect((await put(assigned.event.id, { score: 9 }, member)).status).toBe(200);
  });

  it('a SUPER_ADMIN can read but not give feedback or permissions (403)', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const superAdmin = await createActor('SUPER_ADMIN', null);
    expect((await get(event.id, superAdmin)).status).toBe(200);
    expect((await put(event.id, { score: 9, permissions: { QUOTE: true } }, superAdmin)).status).toBe(403);
    expect(await consents(event.id)).toEqual([]);
    await prisma.user.delete({ where: { id: superAdmin.id } });
  });

  it('with `feedback` off every route is the global 404 for a tenant', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'feedback');
    const { event } = await newEvent(tenantId, organiser.id);
    for (const res of [
      await get(event.id),
      await put(event.id, { score: 9 }),
      await request(app).post(`/api/events/${event.id}/feedback/logo-signature`).set(headersFor(organiser)),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ status: 'error', message: 'Route not found' });
    }
  });
});

describe('the logo', () => {
  const ownLogo = () => {
    const publicId = `${feedbackLogoFolder(tenantId)}/${randomUUID()}`;
    return { url: deliveryUrl(publicId, 'png'), publicId, bytes: 50_000 };
  };

  it("is signed into the tenant's own logo folder", async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const res = await request(app).post(`/api/events/${event.id}/feedback/logo-signature`).set(headersFor(organiser));
    expect(res.status).toBe(200);
    expect(res.body.data.folder).toBe(feedbackLogoFolder(tenantId));
    expect(res.body.data.allowedFormats).toBe('jpg,png,webp');
  });

  it("another tenant's or another folder's id, or a URL for a different id, is 422 and nothing is destroyed", async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const foreign = `${feedbackLogoFolder(otherTenantAdmin.tenantId as string)}/${randomUUID()}`;
    const memoryHubId = `eventgenie/${tenantId}/memory-hub/${event.id}/${randomUUID()}`;
    const own = ownLogo();
    for (const logo of [
      { url: deliveryUrl(foreign, 'png'), publicId: foreign, bytes: 1000 },
      { url: deliveryUrl(memoryHubId, 'png'), publicId: memoryHubId, bytes: 1000 },
      { ...own, url: deliveryUrl(`${feedbackLogoFolder(tenantId)}/${randomUUID()}`, 'png') },
    ]) {
      const res = await put(event.id, { score: 9, logo });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FEEDBACK_LOGO_INVALID');
    }
    expect(mockDestroyAsset).not.toHaveBeenCalled();
    expect(await prisma.eventFeedback.count({ where: { eventId: event.id } })).toBe(0);
  });

  it('too large is 422 and the upload is destroyed; a good one is saved; null removes it', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    const big = { ...ownLogo(), bytes: FEEDBACK_LOGO_MAX_BYTES + 1 };
    const tooLarge = await put(event.id, { score: 9, logo: big });
    expect(tooLarge.status).toBe(422);
    expect(tooLarge.body.code).toBe('FEEDBACK_LOGO_TOO_LARGE');
    expect(mockDestroyAsset).toHaveBeenCalledWith(big.publicId);

    const good = ownLogo();
    const saved = await put(event.id, { score: 9, logo: good });
    expect(saved.status).toBe(200);
    expect(saved.body.data.feedback.logoUrl).toBe(good.url);

    // Re-sent unchanged (without bytes): accepted as it is.
    expect((await put(event.id, { logo: { url: good.url, publicId: good.publicId } })).status).toBe(200);

    const removed = await put(event.id, { logo: null });
    expect(removed.body.data.feedback.logoUrl).toBeNull();
  });
});
