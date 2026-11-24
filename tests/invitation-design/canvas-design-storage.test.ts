import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { eventService } from '../../src/modules/event/event.service.js';
import { mediaRetentionRepository } from '../../src/modules/media-retention/media-retention.repository.js';
import { storedFileService } from '../../src/modules/storage/stored-file.service.js';
import { createTenant, createActor, installFirebaseMock, headersFor, createEventWithDay, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { signedUpload, storedFile } from '../helpers/storage.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { createCustomTier, onCustomTier } from '../custom-tiers/custom-tier-fixtures.js';
import { fabricDocument, fabricImage, fabricSvg } from './canvas-fixtures.js';

// ─────────────────────────────────────────
//  CANVAS DESIGNS — their files through an event's life (STEERING
//  "Storage", "Duplicating an event", "Archived events"): deleting an event,
//  the 30-day archive purge, and duplicating an event onto a plan with and
//  without invitation designs.
//
//  Plans are custom tiers here, so the settings are exactly the test's own
//  (the shared standard tier rows are never touched).
// ─────────────────────────────────────────

const tenantIds: string[] = [];
const customTierIds: string[] = [];

interface Organiser { tenantId: string; admin: Actor; eventId: string }

const organiser = async (opts: { designs: boolean; largePass?: boolean }): Promise<Organiser> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  const tier = await createCustomTier({ invitationDesignsEnabled: opts.designs });
  customTierIds.push(tier.id);
  await onCustomTier(tenant.id, tier.id);
  const { event } = await createEventWithDay(tenant.id, admin.id);
  if (opts.largePass) await prisma.eventPass.create({ data: { eventId: event.id, tenantId: tenant.id, passTier: 'LARGE' } });
  return { tenantId: tenant.id, admin, eventId: event.id };
};

const asset = (o: Organiser, eventId = o.eventId) =>
  signedUpload({ kind: 'DESIGN_ASSET', tenantId: o.tenantId, eventId, uploadedBy: { userId: o.admin.id }, format: 'webp', bytes: 150_000 });
const render = (o: Organiser, eventId = o.eventId) =>
  signedUpload({ kind: 'DESIGN_RENDER', tenantId: o.tenantId, eventId, uploadedBy: { userId: o.admin.id }, format: 'png', width: 1080, height: 1350, bytes: 800_000 });

// A saved design with two images (one placed, one the background).
const saveDesign = async (o: Organiser) => {
  const a = await asset(o);
  const b = await asset(o);
  const card = await render(o);
  const document = { ...fabricDocument(a.url), backgroundImage: fabricImage(b.url, { left: 0, top: 0, width: 1080, height: 1350, scaleX: 1, scaleY: 1 }) };
  const svg = fabricSvg(a.url).replace('<rect x="0" y="0"', `<image xlink:href="${b.url}" x="0" y="0" width="1080" height="1350"></image><rect x="0" y="0"`);
  const res = await request(app).put(`/api/events/${o.eventId}/invitation-design`).set(headersFor(o.admin)).send({
    kind: 'CANVAS', format: '4:5', document, documentVersion: 1, svg, pngPublicId: card.publicId,
    envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'Our card',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { a, b, card, document };
};

beforeAll(() => undefined);
beforeEach(() => {
  installFirebaseMock();
});

afterAll(async () => {
  const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventPass.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventMediaPurge.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.storedFile.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await deleteTenantsDeep(tenantIds);
  await prisma.customTier.deleteMany({ where: { id: { in: customTierIds } } });
}, 120_000);

// ── Deleting an event, and the archive purge ──────────────────

describe('an archived event', () => {
  it('deleting it requests the design uploads never saved, and keeps the saved ones for the purge', async () => {
    const o = await organiser({ designs: true });
    const { a, b, card } = await saveDesign(o);
    const unsavedAsset = await asset(o);
    const unsavedRender = await render(o);

    await eventService.archive(o.eventId, o.admin.id, o.admin.role, o.tenantId);

    expect((await storedFile(unsavedAsset.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(unsavedRender.publicId)).status).toBe('DELETE_REQUESTED');
    for (const f of [a, b, card]) expect((await storedFile(f.publicId)).status, f.publicId).toBe('ATTACHED');
    expect(await mediaRetentionRepository.findKeptCoverAndDesign(o.eventId)).toEqual({ cover: false, design: true });
  }, 60_000);

  it('the 30-day purge requests the design\'s images and rendered card, and archives the design', async () => {
    const o = await organiser({ designs: true });
    const { a, b, card } = await saveDesign(o);
    const startedAt = new Date(Date.now() + 60_000);

    const count = await prisma.$transaction((tx) => mediaRetentionRepository.requestCoverAndDesignFiles(tx, o.eventId, startedAt, new Date(), 'system:test'));

    expect(count).toBe(3);
    for (const f of [a, b, card]) expect((await storedFile(f.publicId)).status, f.publicId).toBe('DELETE_REQUESTED');
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId, isArchived: false } })).toBe(0);
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId, isArchived: true, kind: 'CANVAS' } })).toBe(1);
    expect(await mediaRetentionRepository.findKeptCoverAndDesign(o.eventId)).toEqual({ cover: false, design: false });
    // Until the worker deletes them, the purge counts them as outstanding.
    const outstanding = (await mediaRetentionRepository.findOutstandingFiles(o.eventId, startedAt)).map((f) => f.id);
    for (const f of [a, b, card]) expect(outstanding).toContain(f.fileId);
  }, 60_000);
});

// ── Duplicating an event ──────────────────────────────────────

const duplicate = (o: Organiser) =>
  request(app).post(`/api/events/${o.eventId}/duplicate`).set(headersFor(o.admin)).send({ name: 'The copy', firstDate: '2027-06-10' });

describe('duplicating an event with a CANVAS design', () => {
  it('onto a plan with invitation designs: copied, with its images and card as new files', async () => {
    const o = await organiser({ designs: true });
    const { a, b, card, document } = await saveDesign(o);

    const res = await duplicate(o);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.duplication).toMatchObject({ designCopied: true, designMissing: false, designNotOnPlan: false });
    const copyId = res.body.data.id as string;

    const design = await prisma.invitationDesign.findFirstOrThrow({ where: { eventId: copyId, isArchived: false } });
    expect(design).toMatchObject({ kind: 'CANVAS', format: '4:5', documentVersion: 1, envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'Our card', hasRsvpButton: true });

    // Its card: a new file, in the copy's folder.
    const png = await prisma.storedFile.findUniqueOrThrow({ where: { id: design.pngStoredFileId! } });
    expect(png.id).not.toBe(card.fileId);
    expect(png).toMatchObject({ kind: 'DESIGN_RENDER', status: 'ATTACHED', eventId: copyId });
    expect(png.publicId).toMatch(new RegExp(`^dev/t/${o.tenantId}/e/${copyId}/design-render/[0-9a-f-]{36}$`));

    // Its images: new files, and the document and SVG name them instead.
    const copies = await prisma.storedFile.findMany({ where: { eventId: copyId, kind: 'DESIGN_ASSET' } });
    expect(copies).toHaveLength(2);
    for (const f of copies) {
      expect(f.status).toBe('ATTACHED');
      expect(f.publicId).toMatch(new RegExp(`^dev/t/${o.tenantId}/e/${copyId}/design-asset/[0-9a-f-]{36}$`));
    }
    const json = JSON.stringify(design.document);
    for (const original of [a, b]) {
      expect(json).not.toContain(original.url);
      expect(design.svgMarkup).not.toContain(original.url);
    }
    for (const f of copies) {
      expect(json).toContain(f.publicId);
      expect(design.svgMarkup).toContain(f.publicId);
    }
    // Everything else in the document is as it was.
    const strip = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/https:[^"]+/g, 'URL')) as unknown;
    expect(strip(design.document)).toEqual(strip(document));

    // The originals are still the source's.
    for (const f of [a, b, card]) expect(await storedFile(f.publicId)).toMatchObject({ status: 'ATTACHED', eventId: o.eventId });

    // The copy's design is the copy's own: it saves again as it is.
    const resave = await request(app).put(`/api/events/${copyId}/invitation-design`).set(headersFor(o.admin)).send({
      kind: 'CANVAS', format: '4:5', document: design.document, documentVersion: 1, svg: design.svgMarkup, pngPublicId: png.publicId,
      envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'Our card',
    });
    expect(resave.status, JSON.stringify(resave.body)).toBe(200);
  }, 60_000);

  it('onto a plan without invitation designs: not copied, and no file is made', async () => {
    // The source has designs through its Large Event Pass; the copy has no
    // pass, so it is on the tenant's own plan, without them.
    const o = await organiser({ designs: false, largePass: true });
    await saveDesign(o);
    const uploadsBefore = fakeCloudinary.callsTo('upload').length;

    const res = await duplicate(o);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.duplication).toMatchObject({ designCopied: false, designMissing: false, designNotOnPlan: true });
    const copyId = res.body.data.id as string;
    expect(await prisma.invitationDesign.count({ where: { eventId: copyId } })).toBe(0);
    expect(await prisma.storedFile.count({ where: { OR: [{ eventId: copyId }, { publicId: { startsWith: `dev/t/${o.tenantId}/e/${copyId}/` } }] } })).toBe(0);
    expect(fakeCloudinary.callsTo('upload').length).toBe(uploadsBefore);
    // The source keeps its design.
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId, isArchived: false, kind: 'CANVAS' } })).toBe(1);
  }, 60_000);

  it('with one of its images already gone: not copied (designMissing), and the copies made are released', async () => {
    const o = await organiser({ designs: true });
    const { b } = await saveDesign(o);
    await prisma.storedFile.update({ where: { id: b.fileId }, data: { status: 'DELETE_REQUESTED', deleteRequestedAt: new Date() } });

    const res = await duplicate(o);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.duplication).toMatchObject({ designCopied: false, designMissing: true, designNotOnPlan: false });
    const copyId = res.body.data.id as string;
    expect(await prisma.invitationDesign.count({ where: { eventId: copyId } })).toBe(0);
    // The card and the first image were copied before the gap was found:
    // released (never attached), not left behind.
    const made = await prisma.storedFile.findMany({ where: { publicId: { startsWith: `dev/t/${o.tenantId}/e/${copyId}/` } } });
    expect(made.length).toBeGreaterThan(0);
    for (const f of made) expect(['DELETE_REQUESTED', 'DELETED']).toContain(f.status);
  }, 60_000);
});

// ── Unsaved design images: kept 7 days ────────────────────────

describe('an image uploaded in the editor and not yet saved', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const signedAgo = (fileId: string, ms: number) =>
    prisma.storedFile.update({ where: { id: fileId }, data: { signedAt: new Date(Date.now() - ms) } });

  it('survives the unsaved sweep at 6 days and goes after 7; other kinds keep their 24 hours', async () => {
    const o = await organiser({ designs: true });
    const image = await asset(o);
    const card = await render(o);
    const cover = await signedUpload({ kind: 'COVER', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id } });

    // 25 hours: the card and the cover go, the image stays.
    for (const f of [image, card, cover]) await signedAgo(f.fileId, 25 * 60 * 60 * 1000);
    await storedFileService.sweepUnsaved();
    expect((await storedFile(image.publicId)).status).toBe('SIGNED');
    expect((await storedFile(card.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(cover.publicId)).status).toBe('DELETE_REQUESTED');

    // 6 days: still kept, and still saves.
    await signedAgo(image.fileId, 6 * DAY);
    await storedFileService.sweepUnsaved();
    expect((await storedFile(image.publicId)).status).toBe('SIGNED');

    // Past 7 days: swept, and a save that names it is UPLOAD_NOT_FOUND.
    await signedAgo(image.fileId, 7 * DAY + 60_000);
    await storedFileService.sweepUnsaved();
    expect((await storedFile(image.publicId)).status).toBe('DELETE_REQUESTED');
    const late = await render(o);
    const res = await request(app).put(`/api/events/${o.eventId}/invitation-design`).set(headersFor(o.admin)).send({
      kind: 'CANVAS', format: '4:5', document: fabricDocument(image.url), documentVersion: 1, svg: fabricSvg(image.url),
      pngPublicId: late.publicId, envelopeColor: '#FAF7F2', sealColor: '#6C4CF1', altText: 'Our card',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('UPLOAD_NOT_FOUND');
  }, 60_000);
});
