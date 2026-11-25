import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { storedFileService } from '../../src/modules/storage/stored-file.service.js';
import { createTenant, createActor, installFirebaseMock, headersFor, createEventWithDay, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { signedUpload, storedFile } from '../helpers/storage.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { createCustomTier, onCustomTier } from '../custom-tiers/custom-tier-fixtures.js';
import { fabricDocument, fabricSvg, fabricText } from '../invitation-design/canvas-fixtures.js';

// ─────────────────────────────────────────
//  STARTER DESIGNS (EG-64 Round 2; STEERING "Invitation designs: starter
//  designs")
//
//  The super admin makes, publishes, retires and deletes starters (audit-
//  logged; anyone else gets the global 404), checked by Round 1's own
//  validator, cleaner and render checks with the starter's own images.
//  Organisers list the published ones (every plan) and take their own copy
//  (the plan setting), its images copied into the event's own files.
//
//  Plans are custom tiers (the shared standard tier rows are never touched).
//  Starters, their files, the super admin's audit entries and the tenants
//  are removed afterwards.
// ─────────────────────────────────────────

const INTERNAL = 'evelope_internal';
const tenantIds: string[] = [];
const customTierIds: string[] = [];
const starterIds: string[] = [];
let superAdmin: Actor;
let cloudName: string;

interface Organiser { tenantId: string; admin: Actor; eventId: string }

const organiser = async (designs: boolean): Promise<Organiser> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  const tier = await createCustomTier({ invitationDesignsEnabled: designs });
  customTierIds.push(tier.id);
  await onCustomTier(tenant.id, tier.id);
  const { event } = await createEventWithDay(tenant.id, admin.id);
  return { tenantId: tenant.id, admin, eventId: event.id };
};

const admin = () => headersFor(superAdmin);
const base = '/api/admin/invitation-starters';

// A starter's image and preview, signed for it (held by the internal
// organisation) and "uploaded".
const starterImage = (starterId: string) =>
  signedUpload({ kind: 'STARTER_ASSET', tenantId: INTERNAL, eventId: null, starterId, uploadedBy: { userId: superAdmin.id }, format: 'webp', bytes: 120_000 });
const starterPreview = (starterId: string, size: { width?: number; height?: number } = {}) =>
  signedUpload({
    kind: 'STARTER_RENDER', tenantId: INTERNAL, eventId: null, starterId, uploadedBy: { userId: superAdmin.id },
    format: 'png', width: size.width ?? 1080, height: size.height ?? 1350, bytes: 700_000,
  });

const create = async (body: Record<string, unknown> = {}) => {
  const res = await request(app).post(base).set(admin()).send({ name: 'Botanical wedding', category: 'WEDDING', format: '4:5', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  starterIds.push(res.body.data.id);
  return res.body.data.id as string;
};

const designBody = (imageUrl: string, previewPublicId: string, extra: Record<string, unknown> = {}) => ({
  document: fabricDocument(imageUrl),
  documentVersion: 1,
  svg: fabricSvg(imageUrl),
  previewPublicId,
  envelopeColor: '#FAF7F2',
  sealColor: '#6C4CF1',
  altText: 'A botanical wedding card',
  ...extra,
});

// A starter with a finished design (one image, its preview).
const finished = async (body: Record<string, unknown> = {}) => {
  const id = await create(body);
  const image = await starterImage(id);
  const preview = await starterPreview(id);
  const res = await request(app).put(`${base}/${id}`).set(admin()).send(designBody(image.url, preview.publicId));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { id, image, preview };
};

const published = async (body: Record<string, unknown> = {}) => {
  const s = await finished(body);
  const res = await request(app).post(`${base}/${s.id}/publish`).set(admin());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return s;
};

const fromStarter = (o: Organiser, starterId: unknown) =>
  request(app).post(`/api/events/${o.eventId}/invitation-design/from-starter`).set(headersFor(o.admin)).send({ starterId });

const auditFor = (starterId: string) =>
  prisma.adminAuditEntry.findMany({ where: { actorUserId: superAdmin.id }, orderBy: { createdAt: 'asc' } })
    .then((rows) => rows.filter((r) => (r.details as { starterId?: string }).starterId === starterId).map((r) => r.action));

beforeAll(async () => {
  superAdmin = await createActor('SUPER_ADMIN', null);
  cloudName = requireCloudinaryConfig().cloudName;
}, 60_000);

beforeEach(() => {
  installFirebaseMock();
});

afterAll(async () => {
  const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.storedFile.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.invitationStarter.deleteMany({ where: { id: { in: starterIds } } });
  await prisma.storedFile.deleteMany({ where: { OR: starterIds.map((id) => ({ publicId: { startsWith: `dev/platform/starters/${id}/` } })) } });
  await deleteTenantsDeep(tenantIds);
  await prisma.customTier.deleteMany({ where: { id: { in: customTierIds } } });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120_000);

// ── 1. Super admin only, and audit-logged ─────────────────────

describe('the super admin routes', () => {
  it('anyone else gets the global 404 on every one, and nothing is written', async () => {
    const id = await create();
    const o = await organiser(true);
    const before = await prisma.invitationStarter.findUniqueOrThrow({ where: { id } });
    const calls = [
      request(app).get(base),
      request(app).post(base).send({ name: 'x', category: 'OTHER', format: '4:5' }),
      request(app).put(`${base}/order`).send({ starterIds: [id] }),
      request(app).get(`${base}/${id}`),
      request(app).put(`${base}/${id}`).send({ name: 'Taken over' }),
      request(app).delete(`${base}/${id}`),
      request(app).post(`${base}/${id}/publish`),
      request(app).post(`${base}/${id}/unpublish`),
      request(app).post(`${base}/${id}/retire`),
      request(app).post(`${base}/${id}/upload-signature`).send({ purpose: 'ASSET' }),
    ];
    for (const call of calls) {
      const res = await call.set(headersFor(o.admin));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ status: 'error', message: 'Route not found' });
    }
    expect(await prisma.invitationStarter.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await prisma.storedFile.count({ where: { starterId: id } })).toBe(0);
  }, 60_000);

  it('every change writes an audit entry, platform-wide', async () => {
    const { id } = await finished();
    expect(await auditFor(id)).toEqual(['INVITATION_STARTER_CREATED', 'INVITATION_STARTER_UPDATED']);
    expect((await request(app).post(`${base}/${id}/publish`).set(admin())).status).toBe(200);
    expect((await request(app).post(`${base}/${id}/unpublish`).set(admin())).status).toBe(200);
    expect((await request(app).post(`${base}/${id}/retire`).set(admin())).status).toBe(200);
    expect(await auditFor(id)).toEqual([
      'INVITATION_STARTER_CREATED', 'INVITATION_STARTER_UPDATED', 'INVITATION_STARTER_PUBLISHED',
      'INVITATION_STARTER_UNPUBLISHED', 'INVITATION_STARTER_RETIRED',
    ]);
    const entries = await prisma.adminAuditEntry.findMany({ where: { actorUserId: superAdmin.id, action: { startsWith: 'INVITATION_STARTER_' } } });
    for (const e of entries) {
      expect(e.tenantId).toBeNull();
      // Never the document itself.
      expect(JSON.stringify(e.details)).not.toContain('"objects"');
    }

    const draft = await create();
    expect((await request(app).delete(`${base}/${draft}`).set(admin())).status).toBe(200);
    expect(await auditFor(draft)).toEqual(['INVITATION_STARTER_CREATED', 'INVITATION_STARTER_DELETED']);

    const all = (await request(app).get(base).set(admin())).body.data.map((s: { id: string }) => s.id) as string[];
    const reordered = await request(app).put(`${base}/order`).set(admin()).send({ starterIds: [...all].reverse() });
    expect(reordered.status).toBe(200);
    const order = await prisma.adminAuditEntry.findFirst({ where: { actorUserId: superAdmin.id, action: 'INVITATION_STARTER_REORDERED' } });
    expect(order?.details).toEqual({ starterIds: [...all].reverse() });
    expect(reordered.body.data.map((s: { id: string }) => s.id)).toEqual([...all].reverse());
    // Not every starter, or one twice: refused.
    expect((await request(app).put(`${base}/order`).set(admin()).send({ starterIds: all.slice(1) })).body.code).toBe('INVITATION_STARTER_ORDER_INVALID');
    expect((await request(app).put(`${base}/order`).set(admin()).send({ starterIds: [all[0], ...all] })).body.code).toBe('INVITATION_STARTER_ORDER_INVALID');
  }, 60_000);

  it('the list filters by status, category and format; one starter comes with its document', async () => {
    const wedding = await published({ name: 'Wedding A', category: 'WEDDING' });
    const draft = await create({ name: 'Birthday draft', category: 'BIRTHDAY', format: '9:16' });
    const list = async (q: string) => ((await request(app).get(`${base}${q}`).set(admin())).body.data as { id: string }[]).map((s) => s.id);
    expect(await list('?status=PUBLISHED')).toContain(wedding.id);
    expect(await list('?status=PUBLISHED')).not.toContain(draft);
    expect(await list('?category=BIRTHDAY')).toContain(draft);
    expect(await list('?category=BIRTHDAY')).not.toContain(wedding.id);
    expect(await list('?format=9:16')).toContain(draft);
    expect((await request(app).get(`${base}?status=LIVE`).set(admin())).status).toBe(400);
    const summary = (await request(app).get(base).set(admin())).body.data.find((s: { id: string }) => s.id === wedding.id);
    expect(summary).not.toHaveProperty('document');
    const one = await request(app).get(`${base}/${wedding.id}`).set(admin());
    expect(one.body.data).toMatchObject({ id: wedding.id, status: 'PUBLISHED', document: fabricDocument(wedding.image.url), previewPublicId: wedding.preview.publicId });
    expect(one.body.data.svgMarkup).toMatch(/^<svg/);
  }, 60_000);
});

// ── 2. Validation is Round 1's ────────────────────────────────

describe('a starter is checked like a design', () => {
  const save = async (id: string, imageUrl: string, documentOverride?: unknown, extra: Record<string, unknown> = {}) => {
    const preview = await starterPreview(id);
    return request(app).put(`${base}/${id}`).set(admin()).send({
      ...designBody(imageUrl, preview.publicId),
      ...(documentOverride !== undefined && { document: documentOverride }),
      ...extra,
    });
  };

  it('a font not among the ten, text too small, or an image from outside is refused', async () => {
    const id = await create();
    const image = await starterImage(id);
    const badFont = await save(id, image.url, { version: '7.4.0', objects: [fabricText({ fontFamily: 'Comic Sans MS' })] }, { svg: fabricSvg(image.url, { rsvp: false }) });
    expect(badFont.body.code).toBe('DESIGN_FONT_NOT_ALLOWED');
    const small = await save(id, image.url, { version: '7.4.0', objects: [fabricText({ fontSize: 20 })] }, { svg: fabricSvg(image.url, { rsvp: false }) });
    expect(small.body.code).toBe('DESIGN_TEXT_TOO_SMALL');
    const outside = await save(id, 'https://evil.example/x.webp');
    expect(outside.body.code).toBe('DESIGN_IMAGE_SOURCE_NOT_ALLOWED');
    expect((await prisma.invitationStarter.findUniqueOrThrow({ where: { id } })).document).toBeNull();
  }, 60_000);

  it("its own images pass; another starter's, or an event's, don't", async () => {
    const id = await create();
    const other = await create();
    const othersImage = await starterImage(other);
    expect((await save(id, othersImage.url)).body.code).toBe('DESIGN_IMAGE_SOURCE_NOT_ALLOWED');

    const o = await organiser(true);
    const eventImage = await signedUpload({ kind: 'DESIGN_ASSET', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id }, format: 'webp' });
    expect((await save(id, eventImage.url)).body.code).toBe('DESIGN_IMAGE_SOURCE_NOT_ALLOWED');

    const own = await starterImage(id);
    const ok = await save(id, own.url);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await storedFile(own.publicId)).status).toBe('ATTACHED');
    expect(await storedFile(own.publicId)).toMatchObject({ kind: 'STARTER_ASSET', tenantId: INTERNAL, eventId: null, starterId: id });
    expect(own.publicId).toMatch(new RegExp(`^dev/platform/starters/${id}/asset/[0-9a-f-]{36}$`));
  }, 60_000);

  it("an event's design can't use a starter's image", async () => {
    const { image } = await published();
    const o = await organiser(true);
    const render = await signedUpload({ kind: 'DESIGN_RENDER', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id }, format: 'png', width: 1080, height: 1350 });
    const res = await request(app).put(`/api/events/${o.eventId}/invitation-design`).set(headersFor(o.admin)).send({
      kind: 'CANVAS', format: '4:5', document: fabricDocument(image.url), documentVersion: 1, svg: fabricSvg(image.url),
      pngPublicId: render.publicId, envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'Card',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DESIGN_IMAGE_SOURCE_NOT_ALLOWED');
  }, 60_000);

  it('the SVG is cleaned and the preview checked, as for a design', async () => {
    const id = await create();
    const image = await starterImage(id);
    const wrongSize = await starterPreview(id, { height: 1920 });
    const refused = await request(app).put(`${base}/${id}`).set(admin()).send(designBody(image.url, wrongSize.publicId));
    expect(refused.body.code).toBe('DESIGN_RENDER_INVALID');

    const preview = await starterPreview(id);
    const svg = fabricSvg(image.url).replace('<defs>', '<script>alert(1)</script><defs>');
    expect((await request(app).put(`${base}/${id}`).set(admin()).send({ ...designBody(image.url, preview.publicId), svg })).status).toBe(200);
    expect((await prisma.invitationStarter.findUniqueOrThrow({ where: { id } })).svgMarkup).not.toMatch(/script|alert/);
  }, 60_000);
});

// ── 3. Publish, delete, retire ────────────────────────────────

describe('publishing, deleting and retiring', () => {
  it('publishing needs the design, preview, colours and alt text, all valid', async () => {
    const bare = await create();
    const incomplete = await request(app).post(`${base}/${bare}/publish`).set(admin());
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.code).toBe('INVITATION_STARTER_INCOMPLETE');
    expect(incomplete.body.message).toMatch(/design, preview, envelopeColor, sealColor, altText/);

    // A design saved, then made invalid (a rule tightened): refused.
    const { id } = await finished();
    await prisma.invitationStarter.update({ where: { id }, data: { document: { version: '7.4.0', objects: [fabricText({ fontFamily: 'Arial' })] } } });
    const stale = await request(app).post(`${base}/${id}/publish`).set(admin());
    expect(stale.body.code).toBe('INVITATION_STARTER_INCOMPLETE');
    expect(stale.body.message).toMatch(/no longer passes/);

    const good = await finished();
    const ok = await request(app).post(`${base}/${good.id}/publish`).set(admin());
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'PUBLISHED' });
    expect(new Date(ok.body.data.publishedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await request(app).post(`${base}/${good.id}/publish`).set(admin())).body.code).toBe('INVITATION_STARTER_STATUS_CONFLICT');
  }, 60_000);

  it('only a never-published starter can be deleted, and its files go with it', async () => {
    const { id, image, preview } = await finished();
    const unsaved = await starterImage(id);
    const res = await request(app).delete(`${base}/${id}`).set(admin());
    expect(res.status).toBe(200);
    expect(await prisma.invitationStarter.count({ where: { id } })).toBe(0);
    for (const f of [image, preview, unsaved]) expect(['DELETE_REQUESTED', 'DELETED']).toContain((await storedFile(f.publicId)).status);
    expect(fakeCloudinary.destroyedIds()).toEqual(expect.arrayContaining([image.publicId, preview.publicId]));

    const once = await published();
    expect((await request(app).post(`${base}/${once.id}/unpublish`).set(admin())).status).toBe(200);
    const refused = await request(app).delete(`${base}/${once.id}`).set(admin());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVITATION_STARTER_WAS_PUBLISHED');
    expect((await storedFile(once.image.publicId)).status).toBe('ATTACHED');
  }, 60_000);

  it('retiring keeps its files, and its preview in the admin list', async () => {
    const { id, image, preview } = await published();
    const res = await request(app).post(`${base}/${id}/retire`).set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'RETIRED', previewUrl: `https://res.cloudinary.com/${cloudName}/image/upload/${preview.publicId}.png` });
    for (const f of [image, preview]) expect((await storedFile(f.publicId)).status).toBe('ATTACHED');
    expect((await request(app).post(`${base}/${id}/retire`).set(admin())).body.code).toBe('INVITATION_STARTER_STATUS_CONFLICT');
  }, 60_000);
});

// ── 4. The organisers' list ───────────────────────────────────

describe('GET /api/invitation-starters', () => {
  it('only published starters, never the document, filterable, in order, on every plan', async () => {
    const a = await published({ name: 'Wedding card', category: 'WEDDING', format: '4:5' });
    const b = await published({ name: 'Birthday card', category: 'BIRTHDAY', format: '4:5' });
    const draft = await finished({ name: 'Draft card', category: 'WEDDING' });
    const retired = await published({ name: 'Old card', category: 'WEDDING' });
    await request(app).post(`${base}/${retired.id}/retire`).set(admin());

    // b before a.
    const all = (await request(app).get(base).set(admin())).body.data.map((s: { id: string }) => s.id) as string[];
    const order = [b.id, a.id, ...all.filter((x) => x !== a.id && x !== b.id)];
    expect((await request(app).put(`${base}/order`).set(admin()).send({ starterIds: order })).status).toBe(200);

    for (const designs of [false, true]) {
      const o = await organiser(designs);
      const res = await request(app).get('/api/invitation-starters').set(headersFor(o.admin));
      expect(res.status).toBe(200);
      const ours = (res.body.data as { id: string }[]).filter((s) => [a.id, b.id, draft.id, retired.id].includes(s.id));
      expect(ours.map((s) => s.id)).toEqual([b.id, a.id]);
      for (const card of res.body.data) {
        expect(Object.keys(card).sort()).toEqual(['category', 'envelopeColor', 'format', 'id', 'name', 'previewUrl', 'sealColor']);
      }
      expect(ours[1]).toEqual({
        id: a.id, name: 'Wedding card', category: 'WEDDING', format: '4:5',
        previewUrl: `https://res.cloudinary.com/${cloudName}/image/upload/${a.preview.publicId}.png`,
        envelopeColor: '#FAF7F2', sealColor: '#6C4CF1',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/"document"|"objects"|svgMarkup/);

      const weddings = (await request(app).get('/api/invitation-starters?category=WEDDING').set(headersFor(o.admin))).body.data.map((s: { id: string }) => s.id);
      expect(weddings).toContain(a.id);
      expect(weddings).not.toContain(b.id);
      const tall = (await request(app).get('/api/invitation-starters?format=9:16').set(headersFor(o.admin))).body.data.map((s: { id: string }) => s.id);
      expect(tall).not.toContain(a.id);
      expect((await request(app).get('/api/invitation-starters?status=DRAFT').set(headersFor(o.admin))).body.data.map((s: { id: string }) => s.id)).not.toContain(draft.id);
      expect((await request(app).get('/api/invitation-starters?format=1:1').set(headersFor(o.admin))).status).toBe(400);
    }

    vi.stubEnv('FEATURES_DISABLED', 'invitationDesigns');
    const o = await organiser(true);
    expect((await request(app).get('/api/invitation-starters').set(headersFor(o.admin))).status).toBe(404);
    vi.unstubAllEnvs();
  }, 90_000);
});

// ── 5. Starting a design from a starter ───────────────────────

describe('POST /api/events/:eventId/invitation-design/from-starter', () => {
  it("copies the starter's images into new files of the event and rewrites the URLs; saves nothing", async () => {
    const { id, image } = await published();
    const o = await organiser(true);
    const res = await fromStarter(o, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['altText', 'document', 'documentVersion', 'envelopeColor', 'format', 'name', 'sealColor', 'starterId']);
    expect(res.body.data).toMatchObject({ starterId: id, format: '4:5', documentVersion: 1, envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'A botanical wedding card' });

    const json = JSON.stringify(res.body.data.document);
    expect(json).not.toContain(image.url);
    expect(json).not.toContain('platform/starters');
    const copies = await prisma.storedFile.findMany({ where: { eventId: o.eventId, kind: 'DESIGN_ASSET' } });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ status: 'UPLOADED', tenantId: o.tenantId, uploadedByUserId: o.admin.id, starterId: null });
    expect(copies[0]!.publicId).toMatch(new RegExp(`^dev/t/${o.tenantId}/e/${o.eventId}/design-asset/[0-9a-f-]{36}$`));
    expect(json).toContain(copies[0]!.publicId);
    expect(fakeCloudinary.assets.has(copies[0]!.publicId)).toBe(true);
    // Everything else is the starter's document as it was.
    const strip = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/https:[^"]+/g, 'URL')) as unknown;
    expect(strip(res.body.data.document)).toEqual(strip(fabricDocument(image.url)));
    // No design is saved; the starter's own file is untouched.
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId } })).toBe(0);
    expect(await storedFile(image.publicId)).toMatchObject({ status: 'ATTACHED', starterId: id, eventId: null });
  }, 60_000);

  it('is refused without the plan setting (403), and copies nothing', async () => {
    const { id } = await published();
    const o = await organiser(false);
    const res = await fromStarter(o, id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVITATION_DESIGNS_NOT_ON_PLAN');
    expect(await prisma.storedFile.count({ where: { eventId: o.eventId } })).toBe(0);
  }, 60_000);

  it('a draft, retired or unknown starter is 404', async () => {
    const draft = await finished();
    const retired = await published();
    await request(app).post(`${base}/${retired.id}/retire`).set(admin());
    const unpublished = await published();
    await request(app).post(`${base}/${unpublished.id}/unpublish`).set(admin());
    const o = await organiser(true);
    for (const id of [draft.id, retired.id, unpublished.id, 'no-such-starter']) {
      const res = await fromStarter(o, id);
      expect(res.status, id).toBe(404);
      expect(res.body.code).toBe('INVITATION_STARTER_NOT_FOUND');
    }
    expect((await fromStarter(o, undefined)).status).toBe(422);
    expect(await prisma.storedFile.count({ where: { eventId: o.eventId } })).toBe(0);
  }, 60_000);

  it("saved through Round 1's save, the copy passes; the starter never changes", async () => {
    const { id, image, preview } = await published();
    const starterBefore = await prisma.invitationStarter.findUniqueOrThrow({ where: { id } });
    const o = await organiser(true);
    const copy = (await fromStarter(o, id)).body.data as { document: { objects: { type: string; src?: string }[] } };
    const copiedUrl = copy.document.objects.find((x) => x.type === 'Image')!.src!;

    // The organiser edits it (a new heading) and saves.
    const edited = { ...copy.document, objects: copy.document.objects.map((x) => (x.type === 'Textbox' ? { ...x, text: 'Our own words' } : x)) };
    const render = await signedUpload({ kind: 'DESIGN_RENDER', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id }, format: 'png', width: 1080, height: 1350 });
    const saved = await request(app).put(`/api/events/${o.eventId}/invitation-design`).set(headersFor(o.admin)).send({
      kind: 'CANVAS', format: '4:5', document: edited, documentVersion: 1, svg: fabricSvg(copiedUrl),
      pngPublicId: render.publicId, envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'Our card',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const copyFile = await prisma.storedFile.findFirstOrThrow({ where: { eventId: o.eventId, kind: 'DESIGN_ASSET' } });
    expect(copyFile.status).toBe('ATTACHED');

    // The starter, its document and its files are exactly as they were.
    expect(await prisma.invitationStarter.findUniqueOrThrow({ where: { id } })).toEqual(starterBefore);
    for (const f of [image, preview]) expect(await storedFile(f.publicId)).toMatchObject({ status: 'ATTACHED', starterId: id });
    // And retiring it later doesn't touch the design.
    await request(app).post(`${base}/${id}/retire`).set(admin());
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId, isArchived: false, kind: 'CANVAS' } })).toBe(1);
    expect((await storedFile(copyFile.publicId)).status).toBe('ATTACHED');
  }, 60_000);

  it("an unsaved copy's images are swept after 7 days, not before", async () => {
    const { id } = await published();
    const o = await organiser(true);
    expect((await fromStarter(o, id)).status).toBe(200);
    const copy = await prisma.storedFile.findFirstOrThrow({ where: { eventId: o.eventId, kind: 'DESIGN_ASSET' } });
    const DAY = 24 * 60 * 60 * 1000;

    await prisma.storedFile.update({ where: { id: copy.id }, data: { signedAt: new Date(Date.now() - 6 * DAY) } });
    await storedFileService.sweepUnsaved();
    expect((await storedFile(copy.publicId)).status).toBe('UPLOADED');

    await prisma.storedFile.update({ where: { id: copy.id }, data: { signedAt: new Date(Date.now() - 7 * DAY - 60_000) } });
    await storedFileService.sweepUnsaved();
    expect((await storedFile(copy.publicId)).status).toBe('DELETE_REQUESTED');
  }, 60_000);
});
