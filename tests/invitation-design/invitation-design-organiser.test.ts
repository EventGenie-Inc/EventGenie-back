import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
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
//  INVITATION DESIGNS (V1) — organiser endpoints, over HTTP
//
//  Real Express app, real test database; only Firebase's verifyIdToken is
//  stubbed (tests/setup.ts). The session JWT is signed here with the same
//  JWT_SECRET the authenticate middleware verifies, so requests go through
//  the real authenticate + requireEventAdmin + router + service path, and
//  status codes come from the real global error handler.
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN' | 'EVENT_ADMIN'; tenantId: string };

const tokens = new Map<string, string>(); // firebase token -> uid

const headersFor = (actor: Actor) => {
  const firebaseToken = `inv-design-${actor.id}`;
  tokens.set(firebaseToken, actor.firebaseUid);
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

let ownerTenantId: string;
let otherTenantId: string;
let owner: Actor;
let outsider: Actor;
let eventId: string;
let cancelledEventId: string;

const url = (id: string) => `/api/events/${id}/invitation-design`;

const TEMPLATE_BODY = {
  kind: 'TEMPLATE',
  templateId: 'wedding',
  templateVersion: 1,
  overrides: {
    elements: {
      'host-names': { color: '#1f2937', fontFamily: 'Great Vibes', fontSize: 72, text: 'Sarah & Tom' },
      'day:date(dd month yyyy)': { backgroundColor: '#FAF7F2' },
    },
  },
};

const uploadBodyFor = (id: string, tenantId: string, overrides: Record<string, unknown> = {}) => {
  const { cloudName } = requireCloudinaryConfig();
  const publicId = `eventgenie/${tenantId}/invitation-designs/${id}/${randomUUID()}`;
  return {
    kind: 'UPLOAD',
    imageUrl: `https://res.cloudinary.com/${cloudName}/image/upload/v1700000000/${publicId}.png`,
    cloudinaryPublicId: publicId,
    width: 1080,
    height: 1350,
    altText: 'Our wedding invitation',
    bytes: 2 * 1024 * 1024,
    ...overrides,
  };
};

beforeAll(async () => {
  const t1 = await createTestTenant();
  const t2 = await createTestTenant();
  ownerTenantId = t1.id;
  otherTenantId = t2.id;
  const u1 = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: t1.id });
  const u2 = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: t2.id });
  owner = { id: u1.id, firebaseUid: u1.firebaseUid, email: u1.email, role: 'TENANT_ADMIN', tenantId: t1.id };
  outsider = { id: u2.id, firebaseUid: u2.firebaseUid, email: u2.email, role: 'EVENT_ADMIN', tenantId: t2.id };

  eventId = (await createTestEvent(t1.id, u1.id)).id;
  cancelledEventId = (await createTestEvent(t1.id, u1.id)).id;
  await eventRepository.updateStatus(cancelledEventId, u1.id, 'CANCELLED');
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

afterAll(async () => {
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: [eventId, cancelledEventId] } } });
  await deleteTestEvent(eventId);
  await deleteTestEvent(cancelledEventId);
  await deleteTestUserRow(owner.id);
  await deleteTestUserRow(outsider.id);
  await deleteTestTenant(ownerTenantId);
  await deleteTestTenant(otherTenantId);
  await prisma.$disconnect();
}, 60000);

describe('invitation design — tenant scoping', () => {
  it("another tenant's event is a 404 on GET, PUT and upload-signature, and nothing is written", async () => {
    const h = headersFor(outsider);

    const get = await request(app).get(url(eventId)).set(h);
    expect(get.status).toBe(404);

    const put = await request(app).put(url(eventId)).set(h).send(TEMPLATE_BODY);
    expect(put.status).toBe(404);

    const sig = await request(app).post(`${url(eventId)}/upload-signature`).set(h).send();
    expect(sig.status).toBe(404);

    expect(await prisma.invitationDesign.count({ where: { eventId } })).toBe(0);
  }, 30000);
});

describe('invitation design — cancelled event', () => {
  it('PUT and upload-signature on a CANCELLED event are 409; GET still works', async () => {
    const h = headersFor(owner);

    const put = await request(app).put(url(cancelledEventId)).set(h).send(TEMPLATE_BODY);
    expect(put.status).toBe(409);
    expect(put.body.message).toMatch(/cancelled/i);

    const sig = await request(app).post(`${url(cancelledEventId)}/upload-signature`).set(h).send();
    expect(sig.status).toBe(409);

    const get = await request(app).get(url(cancelledEventId)).set(h);
    expect(get.status).toBe(200);
    expect(get.body.data).toBeNull();
  }, 30000);
});

describe('invitation design — validation (422)', () => {
  const put = (body: unknown) => request(app).put(url(eventId)).set(headersFor(owner)).send(body as object);
  const withElement = (el: Record<string, unknown>) => ({
    ...TEMPLATE_BODY,
    overrides: { elements: { 'host-names': el } },
  });

  it.each([
    ['free-form CSS key on an element', withElement({ color: '#112233', style: 'position:fixed' })],
    ['CSS property name on an element', withElement({ 'font-weight': 700 })],
    ['unknown top-level overrides key', { ...TEMPLATE_BODY, overrides: { elements: {}, css: 'body{}' } }],
    ['unknown key on the PUT body', { ...TEMPLATE_BODY, customCss: 'x' }],
    ['upload field on a template body', { ...TEMPLATE_BODY, imageUrl: 'https://example.com/a.png' }],
  ])('rejects %s', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/can't be saved/);
  });

  it.each([
    ['a named colour', 'red'],
    ['a 3-digit hex', '#fff'],
    ['an 8-digit hex', '#11223344'],
    ['rgb()', 'rgb(0,0,0)'],
    ['a CSS injection attempt', '#112233;background:url(x)'],
  ])('rejects %s as a colour', async (_label, color) => {
    const res = await put(withElement({ color }));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/#1f2937/);

    const bg = await put(withElement({ backgroundColor: color }));
    expect(bg.status).toBe(422);
  });

  it.each(['Comic Sans MS', 'poppins', 'Poppins, sans-serif', 'Arial'])('rejects the font %j', async (fontFamily) => {
    const res = await put(withElement({ fontFamily }));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/available fonts/);
  });

  it('rejects overrides over 20KB', async () => {
    const elements: Record<string, { text: string }> = {};
    for (let i = 0; i < 80; i++) elements[`el-${i}`] = { text: 'x'.repeat(290) };
    const res = await put({ ...TEMPLATE_BODY, overrides: { elements } });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/too large/);
  });

  it('rejects fontSize outside 10-200 and text over 300 characters', async () => {
    expect((await put(withElement({ fontSize: 9 }))).status).toBe(422);
    expect((await put(withElement({ fontSize: 201 }))).status).toBe(422);
    expect((await put(withElement({ fontSize: '20px' }))).status).toBe(422);
    expect((await put(withElement({ text: 'a'.repeat(301) }))).status).toBe(422);
  });

  it('rejects a bad templateId or templateVersion', async () => {
    expect((await put({ ...TEMPLATE_BODY, templateId: 'Wedding Classic' })).status).toBe(422);
    expect((await put({ ...TEMPLATE_BODY, templateVersion: 0 })).status).toBe(422);
    expect((await put({ ...TEMPLATE_BODY, templateVersion: 1.5 })).status).toBe(422);
  });

  it.each([
    ['another host entirely', { imageUrl: 'https://evil.example.com/a.png' }],
    ['another Cloudinary account', { imageUrl: 'https://res.cloudinary.com/someone-else/image/upload/v1/x.png' }],
    ['http, not https', {}], // imageUrl patched below
  ])('rejects a foreign image URL: %s', async (label, patch) => {
    let body = uploadBodyFor(eventId, ownerTenantId, patch);
    if (label === 'http, not https') body = { ...body, imageUrl: body.imageUrl.replace('https://', 'http://') };
    const res = await put(body);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/image link/);
  });

  it("rejects an image URL that doesn't match the publicId", async () => {
    const a = uploadBodyFor(eventId, ownerTenantId);
    const b = uploadBodyFor(eventId, ownerTenantId);
    const res = await put({ ...a, imageUrl: b.imageUrl });
    expect(res.status).toBe(422);
  });

  it("rejects a publicId from another event's or another tenant's folder, even with a matching URL", async () => {
    const otherEvent = uploadBodyFor(cancelledEventId, ownerTenantId);
    expect((await put(otherEvent)).status).toBe(422);

    const otherTenant = uploadBodyFor(eventId, otherTenantId);
    const res = await put(otherTenant);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/wasn't uploaded for this event/);
  });

  it('rejects an upload over 10MB', async () => {
    const res = await put(uploadBodyFor(eventId, ownerTenantId, { bytes: 10 * 1024 * 1024 + 1 }));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/too large/);
  });

  it('wrote nothing for any rejected request', async () => {
    expect(await prisma.invitationDesign.count({ where: { eventId } })).toBe(0);
  });
});

describe('invitation design — create, replace, switch kind', () => {
  it('PUT creates, a second PUT replaces, switching kind updates the SAME record', async () => {
    const h = headersFor(owner);

    const empty = await request(app).get(url(eventId)).set(h);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    const created = await request(app).put(url(eventId)).set(h).send(TEMPLATE_BODY);
    expect(created.status).toBe(200);
    expect(created.body.data.kind).toBe('TEMPLATE');
    expect(created.body.data.overrides).toEqual(TEMPLATE_BODY.overrides);
    const id = created.body.data.id as string;

    const upload = uploadBodyFor(eventId, ownerTenantId);
    const switched = await request(app).put(url(eventId)).set(h).send(upload);
    expect(switched.status).toBe(200);
    expect(switched.body.data.id).toBe(id);
    expect(switched.body.data).toMatchObject({
      kind: 'UPLOAD',
      imageUrl: upload.imageUrl,
      cloudinaryPublicId: upload.cloudinaryPublicId,
      width: 1080,
      height: 1350,
      altText: 'Our wedding invitation',
      templateId: null,
      templateVersion: null,
      overrides: null,
    });
    expect(switched.body.data).not.toHaveProperty('bytes');

    const back = await request(app).put(url(eventId)).set(h).send(TEMPLATE_BODY);
    expect(back.body.data.id).toBe(id);
    expect(back.body.data).toMatchObject({ kind: 'TEMPLATE', imageUrl: null, cloudinaryPublicId: null, width: null });

    expect(await prisma.invitationDesign.count({ where: { eventId } })).toBe(1);
  }, 30000);

  it('upload-signature signs into the per-event folder with a server-chosen publicId', async () => {
    const res = await request(app).post(`${url(eventId)}/upload-signature`).set(headersFor(owner)).send({ folder: 'elsewhere' });
    expect(res.status).toBe(200);
    expect(res.body.data.folder).toBe(`eventgenie/${ownerTenantId}/invitation-designs/${eventId}`);
    expect(res.body.data.publicId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.allowedFormats).toBe('jpg,png,webp');
    expect(res.body.data.maxFileSizeBytes).toBe(10 * 1024 * 1024);
  });

  it('the database refuses a second active design for the same event (partial unique index)', async () => {
    const existing = await prisma.invitationDesign.findFirstOrThrow({ where: { eventId, isArchived: false } });
    await expect(
      prisma.invitationDesign.create({
        data: {
          eventId, kind: 'TEMPLATE', templateId: 'wedding', templateVersion: 1,
          overrides: { elements: {} }, createdBy: owner.id, updatedBy: owner.id,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(existing.isArchived).toBe(false);
  });
});
