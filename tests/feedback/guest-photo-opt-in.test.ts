import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { createTenant, createActor, prisma, type Actor } from '../helpers/team.js';
import {
  addPhoto,
  cleanupTenants,
  deliveryUrl,
  enableMemoryHubOnElevate,
  newEvent,
  newGuest,
  restoreElevate,
  setGuestSharing,
  type TestEvent,
} from './helpers.js';

// ─────────────────────────────────────────
//  GUEST PHOTO OPT-IN
//
//  POST /api/memory-hub/guest-items takes an optional allowPublicSharing,
//  off unless it is exactly true; true records a PHOTO_GUEST_PUBLIC_SHARING
//  grant for the new photo with its wording. The guest changes it later
//  through POST /api/memory-hub/guest-items/:itemId/public-sharing (their
//  own photos only), and guest-view shows each of their photos' setting.
//  With `feedback` off nothing is recorded or shown, and the toggle is 404.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;

beforeAll(async () => {
  await enableMemoryHubOnElevate();
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await cleanupTenants(tenantIds.splice(0));
  await restoreElevate();
}, 120000);

const setup = async () => {
  const ev = await newEvent(organiser.tenantId as string, organiser.id);
  const { guest, invite } = await newGuest(ev.event.id, organiser.id);
  return { ev, guest, token: invite.token };
};

const upload = (ev: TestEvent, token: string, extra: Record<string, unknown> = {}, mediaType: 'IMAGE' | 'VIDEO' = 'IMAGE') => {
  const publicId = `${ev.folder}/${randomUUID()}`;
  return request(app)
    .post('/api/memory-hub/guest-items')
    .send({
      token,
      mediaUrl: mediaType === 'IMAGE' ? deliveryUrl(publicId, 'jpg') : deliveryUrl(publicId, 'mp4', 'video'),
      cloudinaryPublicId: publicId,
      mediaType,
      bytes: 1000,
      ...extra,
    });
};

const consentsFor = (memoryItemId: string) =>
  prisma.consentRecord.findMany({ where: { memoryItemId }, orderBy: { seq: 'asc' } });

const guestView = async (token: string) => {
  const res = await request(app).post('/api/memory-hub/guest-view').send({ token });
  expect(res.status).toBe(200);
  return res.body.data;
};

describe('uploading', () => {
  it('left out, the opt-in is OFF: no record, and guest-view shows the photo as not shared', async () => {
    const { ev, token } = await setup();
    const res = await upload(ev, token);
    expect(res.status).toBe(201);
    expect(res.body.data.allowPublicSharing).toBe(false);
    expect(await consentsFor(res.body.data.id)).toEqual([]);

    const view = await guestView(token);
    expect(view.publicSharing.myItems).toEqual([{ id: res.body.data.id, allowPublicSharing: false }]);
  });

  it('false is off too, and anything but true or false is a 400 with nothing saved', async () => {
    const { ev, guest, token } = await setup();
    const off = await upload(ev, token, { allowPublicSharing: false });
    expect(off.status).toBe(201);
    expect(await consentsFor(off.body.data.id)).toEqual([]);

    const bad = await upload(ev, token, { allowPublicSharing: 'yes' });
    expect(bad.status).toBe(400);
    expect(await prisma.memoryItem.count({ where: { uploadedByGuestId: guest.id } })).toBe(1);
  });

  it('true records a PHOTO_GUEST_PUBLIC_SHARING grant for that photo, by that guest, with the exact wording', async () => {
    const { ev, guest, token } = await setup();
    const res = await upload(ev, token, { allowPublicSharing: true });
    expect(res.status).toBe(201);
    expect(res.body.data.allowPublicSharing).toBe(true);

    const records = await consentsFor(res.body.data.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventId: ev.event.id,
      kind: 'PHOTO_GUEST_PUBLIC_SHARING',
      memoryItemId: res.body.data.id,
      guestId: guest.id,
      userId: null,
      action: 'GRANTED',
      wording: 'Happy for this photo to be shared publicly by the organiser and e-velope.',
      wordingVersion: 1,
    });
  });

  it('a video asked to be shared is refused (photos only) and nothing is saved', async () => {
    const { ev, guest, token } = await setup();
    const res = await upload(ev, token, { allowPublicSharing: true }, 'VIDEO');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PUBLIC_SHARING_PHOTOS_ONLY');
    expect(await prisma.memoryItem.count({ where: { uploadedByGuestId: guest.id } })).toBe(0);
  });
});

describe('changing it later', () => {
  const toggle = (itemId: string, token: string, allowPublicSharing: unknown) =>
    request(app).post(`/api/memory-hub/guest-items/${itemId}/public-sharing`).send({ token, allowPublicSharing });

  it("the guest withdraws and re-grants their own photo; each change is a new record, and guest-view follows", async () => {
    const { ev, token } = await setup();
    const { body } = await upload(ev, token, { allowPublicSharing: true });
    const itemId = body.data.id as string;

    const off = await toggle(itemId, token, false);
    expect(off.status).toBe(200);
    expect(off.body.data).toEqual({ id: itemId, allowPublicSharing: false });
    expect((await guestView(token)).publicSharing.myItems).toEqual([{ id: itemId, allowPublicSharing: false }]);

    // Setting what is already current records nothing.
    expect((await toggle(itemId, token, false)).status).toBe(200);
    expect((await consentsFor(itemId)).map((r) => r.action)).toEqual(['GRANTED', 'WITHDRAWN']);

    expect((await toggle(itemId, token, true)).status).toBe(200);
    expect((await consentsFor(itemId)).map((r) => r.action)).toEqual(['GRANTED', 'WITHDRAWN', 'GRANTED']);
    expect((await guestView(token)).publicSharing.myItems).toEqual([{ id: itemId, allowPublicSharing: true }]);
  });

  it("another guest's photo, an organiser's photo, or an archived one is a 404 and records nothing", async () => {
    const { ev, guest, token } = await setup();
    const { guest: other } = await newGuest(ev.event.id, organiser.id);
    const theirs = await addPhoto(ev, { guestId: other.id });
    const organisers = await addPhoto(ev, { userId: organiser.id });
    const archived = await addPhoto(ev, { guestId: guest.id, isArchived: true });

    for (const item of [theirs, organisers, archived]) {
      const res = await toggle(item.id, token, true);
      expect(res.status).toBe(404);
      expect(await consentsFor(item.id)).toEqual([]);
    }
  });

  it('a bad token is 404, a missing or non-boolean value 400', async () => {
    const { ev, guest, token } = await setup();
    const mine = await addPhoto(ev, { guestId: guest.id });
    expect((await toggle(mine.id, 'not-a-token', true)).status).toBe(404);
    expect((await toggle(mine.id, token, undefined)).status).toBe(400);
    expect((await toggle(mine.id, token, 'true')).status).toBe(400);
  });
});

describe('guest-view', () => {
  it("shows each of the guest's own photos (pending and approved) with its current setting, and the wording; no one else's", async () => {
    const { ev, guest, token } = await setup();
    const { guest: other } = await newGuest(ev.event.id, organiser.id);
    const pending = await addPhoto(ev, { guestId: guest.id, status: 'PENDING' });
    const approved = await addPhoto(ev, { guestId: guest.id });
    await addPhoto(ev, { guestId: guest.id, status: 'REJECTED' });
    await addPhoto(ev, { guestId: other.id });
    await setGuestSharing(ev.event.id, guest.id, approved.id, true);

    const view = await guestView(token);
    expect(view.publicSharing.wording).toEqual({
      version: 1,
      text: 'Happy for this photo to be shared publicly by the organiser and e-velope.',
    });
    expect(view.publicSharing.myItems).toEqual([
      { id: approved.id, allowPublicSharing: true },
      { id: pending.id, allowPublicSharing: false },
    ]);
  });
});

describe('with `feedback` off', () => {
  it('true is ignored on upload, guest-view has no publicSharing, and the toggle is 404', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'feedback');
    const { ev, guest, token } = await setup();
    const res = await upload(ev, token, { allowPublicSharing: true });
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('allowPublicSharing');
    expect(await consentsFor(res.body.data.id)).toEqual([]);

    expect(await guestView(token)).not.toHaveProperty('publicSharing');

    const mine = await addPhoto(ev, { guestId: guest.id });
    const toggled = await request(app).post(`/api/memory-hub/guest-items/${mine.id}/public-sharing`).send({ token, allowPublicSharing: true });
    expect(toggled.status).toBe(404);
    expect(toggled.body).toEqual({ status: 'error', message: 'Route not found' });
  });
});
