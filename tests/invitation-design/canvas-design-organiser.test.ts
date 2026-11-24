import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { type SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { createTenant, createActor, installFirebaseMock, headersFor, createEventWithDay, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import { signedUpload, storedFile } from '../helpers/storage.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { createCustomTier, onCustomTier } from '../custom-tiers/custom-tier-fixtures.js';
import { fabricDocument, fabricImage, fabricSvg } from './canvas-fixtures.js';

// ─────────────────────────────────────────
//  CANVAS DESIGNS — the organiser's endpoints, over HTTP, and what guests
//  then receive (STEERING "Invitation designs").
//
//  Real app and test database; Cloudinary is the fake (tests/setup.ts).
//  The standard tier rows are shared: each is saved first and put back
//  whole (with updatedAt) afterwards; only invitationDesignsEnabled is set
//  here, to the migration's values (Elevate on, Spark and Celebrate off).
// ─────────────────────────────────────────

const TIERS: SubscriptionTier[] = ['SPARK', 'CELEBRATE', 'ELEVATE'];
let savedTiers: SubscriptionTierConfig[] = [];
const tenantIds: string[] = [];
const customTierIds: string[] = [];

type Plan =
  | { tier: SubscriptionTier; pass?: 'SMALL' | 'STANDARD' | 'LARGE' }
  | { custom: { invitationDesignsEnabled: boolean }; pass?: 'SMALL' | 'STANDARD' | 'LARGE' };

interface Organiser { tenantId: string; admin: Actor; eventId: string; dayId: string; customTierName?: string }

const organiserOn = async (plan: Plan): Promise<Organiser> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  let customTierName: string | undefined;
  if ('tier' in plan) {
    await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: plan.tier } });
  } else {
    const tier = await createCustomTier({ invitationDesignsEnabled: plan.custom.invitationDesignsEnabled });
    customTierIds.push(tier.id);
    customTierName = tier.name;
    await onCustomTier(tenant.id, tier.id);
  }
  const { event, day } = await createEventWithDay(tenant.id, admin.id);
  if (plan.pass) await prisma.eventPass.create({ data: { eventId: event.id, tenantId: tenant.id, passTier: plan.pass } });
  return { tenantId: tenant.id, admin, eventId: event.id, dayId: day.id, ...(customTierName ? { customTierName } : {}) };
};

const url = (eventId: string) => `/api/events/${eventId}/invitation-design`;

// An image placed in the design: signed for this event and "uploaded".
const designImage = async (o: Organiser, opts: { bytes?: number } = {}) => {
  const up = await signedUpload({ kind: 'DESIGN_ASSET', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id }, format: 'webp', bytes: opts.bytes ?? 200_000 });
  return { ...up, url: up.url };
};

// The design's rendered card.
const designRender = async (o: Organiser, opts: { width?: number; height?: number; format?: string; bytes?: number; eventId?: string } = {}) =>
  signedUpload({
    kind: 'DESIGN_RENDER',
    tenantId: o.tenantId,
    eventId: opts.eventId ?? o.eventId,
    uploadedBy: { userId: o.admin.id },
    format: opts.format ?? 'png',
    width: opts.width ?? 1080,
    height: opts.height ?? 1350,
    bytes: opts.bytes ?? 900_000,
  });

const canvasBody = (imageUrl: string, pngPublicId: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'CANVAS',
  format: '4:5',
  document: fabricDocument(imageUrl),
  documentVersion: 1,
  svg: fabricSvg(imageUrl),
  pngPublicId,
  envelopeColor: '#FAF7F2',
  sealColor: '#6C4CF1',
  altText: 'Thandi and Sipho are getting married',
  ...overrides,
});

// A complete, valid save for this organiser's event.
const validSave = async (o: Organiser, overrides: Record<string, unknown> = {}) => {
  const image = await designImage(o);
  const render = await designRender(o);
  return { image, render, body: canvasBody(image.url, render.publicId, overrides) };
};

const put = (o: Organiser, body: unknown, as: Actor = o.admin) => request(app).put(url(o.eventId)).set(headersFor(as)).send(body as object);
const sign = (o: Organiser, purpose: unknown, as: Actor = o.admin) =>
  request(app).post(`${url(o.eventId)}/canvas-upload-signature`).set(headersFor(as)).send({ purpose });

const guestDesign = async (o: Organiser) => {
  const { invite } = await createTestGuestWithInvite(o.eventId, o.admin.id, [o.dayId]);
  return (await rsvpService.validate(invite.token)).design;
};

beforeAll(async () => {
  savedTiers = await prisma.subscriptionTierConfig.findMany({ where: { tier: { in: TIERS } } });
  for (const tier of TIERS) {
    await prisma.subscriptionTierConfig.updateMany({ where: { tier }, data: { invitationDesignsEnabled: tier === 'ELEVATE' } });
  }
}, 60_000);

beforeEach(() => {
  installFirebaseMock();
});

afterAll(async () => {
  for (const row of savedTiers) {
    const { tier, ...values } = row;
    await prisma.subscriptionTierConfig.upsert({ where: { tier }, create: row, update: values });
  }
  const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventPass.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.storedFile.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await deleteTenantsDeep(tenantIds);
  await prisma.customTier.deleteMany({ where: { id: { in: customTierIds } } });
}, 120_000);

// ── 1. The plan gate ──────────────────────────────────────────

describe('the plan gate', () => {
  const expectNotOnPlan = async (o: Organiser, words: RegExp) => {
    const { body } = await validSave(o);
    const saved = await put(o, body);
    expect(saved.status).toBe(403);
    expect(saved.body.code).toBe('INVITATION_DESIGNS_NOT_ON_PLAN');
    expect(saved.body.message).toMatch(words);
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId } })).toBe(0);

    const filesBefore = await prisma.storedFile.count({ where: { eventId: o.eventId } });
    for (const purpose of ['ASSET', 'RENDER']) {
      const signed = await sign(o, purpose);
      expect(signed.status).toBe(403);
      expect(signed.body.code).toBe('INVITATION_DESIGNS_NOT_ON_PLAN');
      expect(signed.body.message).toMatch(words);
    }
    // A refused signature writes no StoredFile.
    expect(await prisma.storedFile.count({ where: { eventId: o.eventId } })).toBe(filesBefore);
  };

  it('Spark is refused, by its display name', async () => {
    await expectNotOnPlan(await organiserOn({ tier: 'SPARK' }), /^The Spark plan doesn't include invitation designs\. Upgrade your plan/);
  }, 60_000);

  it('Celebrate is refused, by its display name', async () => {
    await expectNotOnPlan(await organiserOn({ tier: 'CELEBRATE' }), /^The Celebrate plan doesn't include invitation designs/);
  }, 60_000);

  it('a custom tier with the setting off is refused, naming it, with the contact wording', async () => {
    const o = await organiserOn({ custom: { invitationDesignsEnabled: false } });
    await expectNotOnPlan(o, new RegExp(`^Invitation designs aren't available on your ${o.customTierName} plan\\. Contact us at admin@e-velope\\.co\\.za`));
  }, 60_000);

  it('a Small Event Pass (Celebrate\'s settings) is refused', async () => {
    await expectNotOnPlan(await organiserOn({ tier: 'SPARK', pass: 'SMALL' }), /^The Celebrate plan doesn't include invitation designs/);
  }, 60_000);

  const expectAllowed = async (o: Organiser) => {
    for (const purpose of ['ASSET', 'RENDER'] as const) {
      const signed = await sign(o, purpose);
      expect(signed.status).toBe(200);
      expect(signed.body.data.folder).toMatch(new RegExp(`^dev/t/${o.tenantId}/e/${o.eventId}/design-${purpose === 'ASSET' ? 'asset' : 'render'}$`));
      expect(signed.body.data.allowedFormats).toBe(purpose === 'ASSET' ? 'webp,jpg,png' : 'png,webp');
      expect(signed.body.data.maxFileSizeBytes).toBe(purpose === 'ASSET' ? 10 * 1024 * 1024 : 5 * 1024 * 1024);
      const row = await storedFile(`${signed.body.data.folder}/${signed.body.data.publicId}`);
      expect(row).toMatchObject({ kind: purpose === 'ASSET' ? 'DESIGN_ASSET' : 'DESIGN_RENDER', status: 'SIGNED', eventId: o.eventId });
    }
    const { body } = await validSave(o);
    const saved = await put(o, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ kind: 'CANVAS', editable: true, notEditableReason: null });
  };

  it('Elevate is allowed', async () => {
    await expectAllowed(await organiserOn({ tier: 'ELEVATE' }));
  }, 60_000);

  it('a Large Event Pass (Elevate\'s settings) on Spark is allowed', async () => {
    await expectAllowed(await organiserOn({ tier: 'SPARK', pass: 'LARGE' }));
  }, 60_000);

  it('a custom tier with the setting on is allowed', async () => {
    await expectAllowed(await organiserOn({ custom: { invitationDesignsEnabled: true } }));
  }, 60_000);

  it('an upload signature must say what it is for', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    for (const purpose of [undefined, 'COVER', 'asset', 42]) {
      const signed = await sign(o, purpose);
      expect(signed.status).toBe(422);
      expect(signed.body.code).toBe('DESIGN_UPLOAD_PURPOSE_INVALID');
    }
  }, 60_000);

  it("another tenant's event is a 404 for saving, resetting and signing", async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const outsider = await organiserOn({ tier: 'ELEVATE' });
    const { body } = await validSave(o);
    expect((await put(o, body, outsider.admin)).status).toBe(404);
    expect((await request(app).delete(url(o.eventId)).set(headersFor(outsider.admin))).status).toBe(404);
    expect((await sign(o, 'ASSET', outsider.admin)).status).toBe(404);
  }, 60_000);
});

// ── 2. Saving, and what the organiser reads back ──────────────

describe('saving a CANVAS design', () => {
  it('saves the document, the cleaned SVG and the rendered card; GET returns all of it', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const { image, render, body } = await validSave(o);
    const saved = await put(o, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const { cloudName } = requireCloudinaryConfig();
    const got = await request(app).get(url(o.eventId)).set(headersFor(o.admin));
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({
      kind: 'CANVAS',
      format: '4:5',
      document: body.document,
      documentVersion: 1,
      envelopeColor: '#FAF7F2',
      sealColor: '#6C4CF1',
      altText: 'Thandi and Sipho are getting married',
      hasRsvpButton: true,
      pngUrl: `https://res.cloudinary.com/${cloudName}/image/upload/${render.publicId}.png`,
      editable: true,
      notEditableReason: null,
    });
    expect(got.body.data.svgMarkup).toMatch(/^<svg/);
    expect(got.body.data.svgMarkup).toContain(image.url);
    expect(got.body.data).not.toHaveProperty('pngStoredFile');
    expect((await storedFile(image.publicId)).status).toBe('ATTACHED');
    expect((await storedFile(render.publicId)).status).toBe('ATTACHED');
  }, 60_000);

  it('hasRsvpButton is worked out from the document, not sent', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const image = await designImage(o);
    const render = await designRender(o);
    const body = canvasBody(image.url, render.publicId, { document: fabricDocument(image.url, { rsvp: false }), svg: fabricSvg(image.url, { rsvp: false }) });
    expect((await put(o, { ...body, hasRsvpButton: true })).body.code).toBe('DESIGN_FIELD_INVALID');
    const saved = await put(o, body);
    expect(saved.status).toBe(200);
    expect(saved.body.data.hasRsvpButton).toBe(false);
  }, 60_000);

  it('an SVG with a script is stored cleaned, and the kinds stripped are logged (not the content)', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const image = await designImage(o);
    const render = await designRender(o);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const svg = fabricSvg(image.url).replace('<defs>', '<script>steal(document.cookie)</script><defs>').replace('<rect x="0"', '<rect onload="steal()" x="0"');
    const saved = await put(o, canvasBody(image.url, render.publicId, { svg }));
    expect(saved.status).toBe(200);
    const row = await prisma.invitationDesign.findFirstOrThrow({ where: { eventId: o.eventId, isArchived: false } });
    expect(row.svgMarkup).not.toMatch(/script|onload|steal/);
    const logged = warn.mock.calls.map((c) => c.join(' ')).find((line) => line.includes('[invitation-design]'));
    expect(logged).toContain('stripped: attribute:on*, element:script');
    expect(logged).not.toMatch(/steal|cookie/);
    warn.mockRestore();
  }, 60_000);

  it('the body is checked: format, colours, alt text, unknown keys', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const { body } = await validSave(o);
    for (const [change, code] of [
      [{ format: '1:1' }, 'DESIGN_FIELD_INVALID'],
      [{ documentVersion: 0 }, 'DESIGN_FIELD_INVALID'],
      [{ envelopeColor: 'white' }, 'DESIGN_COLOUR_INVALID'],
      [{ sealColor: '#abc' }, 'DESIGN_COLOUR_INVALID'],
      [{ altText: '   ' }, 'DESIGN_FIELD_INVALID'],
      [{ altText: 'x'.repeat(301) }, 'DESIGN_FIELD_INVALID'],
      [{ pngStoredFileId: 'abc' }, 'DESIGN_FIELD_INVALID'],
      [{ document: fabricDocument('https://evil.example/x.webp') }, 'DESIGN_IMAGE_SOURCE_NOT_ALLOWED'],
      [{ svg: '<div>no</div>' }, 'DESIGN_SVG_INVALID'],
      [{ format: '9:16' }, 'DESIGN_SVG_VIEWBOX_MISMATCH'],
    ] as const) {
      const res = await put(o, { ...body, ...change });
      expect(res.status, JSON.stringify(change)).toBe(422);
      expect(res.body.code, JSON.stringify(change)).toBe(code);
    }
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId } })).toBe(0);
  }, 60_000);
});

// ── 3. The rendered card's checks ─────────────────────────────

describe('the rendered card', () => {
  const save = async (o: Organiser, render: { publicId: string }, format: '4:5' | '9:16' = '4:5') => {
    const image = await designImage(o);
    return put(o, canvasBody(image.url, render.publicId, { format, svg: fabricSvg(image.url, { format }) }));
  };

  it('must be 1080 wide and the format\'s height', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    for (const [size, format] of [[{ width: 1080, height: 1350 }, '9:16'], [{ width: 1080, height: 1920 }, '4:5'], [{ width: 1000, height: 1350 }, '4:5'], [{ width: 2160, height: 2700 }, '4:5']] as const) {
      const res = await save(o, await designRender(o, size), format);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DESIGN_RENDER_INVALID');
      expect(res.body.message).toMatch(format === '9:16' ? /1080 by 1920/ : /1080 by 1350/);
    }
    expect((await save(o, await designRender(o, { width: 1080, height: 1920 }), '9:16')).status).toBe(200);
  }, 60_000);

  it('must be PNG or WebP', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    for (const format of ['jpg', 'gif', 'svg']) {
      const res = await save(o, await designRender(o, { format }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DESIGN_RENDER_INVALID');
    }
    expect((await save(o, await designRender(o, { format: 'webp' }))).status).toBe(200);
    expect((await save(o, await designRender(o, { format: 'png' }))).status).toBe(200);
  }, 60_000);

  it('must be at most 5MB (Cloudinary\'s figure); a larger one is refused and deleted', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const big = await designRender(o, { bytes: 5 * 1024 * 1024 + 1 });
    const res = await save(o, big);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DESIGN_RENDER_TOO_LARGE');
    expect((await storedFile(big.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await save(o, await designRender(o, { bytes: 5 * 1024 * 1024 }))).status).toBe(200);
  }, 60_000);

  it('must be an upload signed for this event, as a rendered card', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const other = await organiserOn({ tier: 'ELEVATE' });
    const elsewhere = await designRender(other);
    expect((await save(o, elsewhere)).body.code).toBe('UPLOAD_NOT_FOUND');
    // An image upload is not a rendered card.
    const image = await designImage(o);
    expect((await save(o, image)).body.code).toBe('UPLOAD_NOT_FOUND');
    // Signed, never uploaded.
    const never = await signedUpload({ kind: 'DESIGN_RENDER', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id }, uploaded: false });
    expect((await save(o, never)).body.code).toBe('UPLOAD_NOT_FOUND');
  }, 60_000);
});

// ── 4. Images: only the current files are kept ────────────────

describe('a design\'s files', () => {
  it('replacing an image, or the rendered card, requests the old file\'s deletion with the save', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const a = await designImage(o);
    const b = await designImage(o);
    const first = await designRender(o);
    expect((await put(o, canvasBody(a.url, first.publicId, {
      document: fabricDocument(a.url, { objects: [fabricImage(a.url), fabricImage(b.url, { left: 500 })], rsvp: false }),
      svg: fabricSvg(a.url, { rsvp: false }).replace('</svg>', `<image xlink:href="${b.url}" width="1" height="1"></image></svg>`),
    }))).status).toBe(200);
    expect((await storedFile(a.publicId)).status).toBe('ATTACHED');
    expect((await storedFile(b.publicId)).status).toBe('ATTACHED');

    // Saved again with b and a new card: a and the first card go.
    const second = await designRender(o);
    expect((await put(o, canvasBody(b.url, second.publicId))).status).toBe(200);
    expect((await storedFile(a.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(first.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(b.publicId)).status).toBe('ATTACHED');
    expect((await storedFile(second.publicId)).status).toBe('ATTACHED');

    // Saved again unchanged (the same image and card): nothing is measured
    // again or deleted.
    const explicitBefore = fakeCloudinary.callsTo('explicit').length;
    expect((await put(o, canvasBody(b.url, second.publicId))).status).toBe(200);
    expect(fakeCloudinary.callsTo('explicit').length).toBe(explicitBefore);
    expect((await storedFile(b.publicId)).status).toBe('ATTACHED');
    expect((await storedFile(second.publicId)).status).toBe('ATTACHED');

    // A deleted image can't be put back.
    expect((await put(o, canvasBody(a.url, second.publicId))).body.code).toBe('UPLOAD_NOT_FOUND');
  }, 60_000);

  it('an image over 10MB is refused and deleted; one never uploaded is refused', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const big = await designImage(o, { bytes: 10 * 1024 * 1024 + 1 });
    const res = await put(o, canvasBody(big.url, (await designRender(o)).publicId));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/too large/);
    expect((await storedFile(big.publicId)).status).toBe('DELETE_REQUESTED');

    // This event's folder, but never signed by us.
    const { cloudName } = requireCloudinaryConfig();
    const forged = `https://res.cloudinary.com/${cloudName}/image/upload/v1/dev/t/${o.tenantId}/e/${o.eventId}/design-asset/0f8c2a3e-1b2c-4d5e-8f90-123456789abc.webp`;
    expect((await put(o, canvasBody(forged, (await designRender(o)).publicId))).body.code).toBe('UPLOAD_NOT_FOUND');
  }, 60_000);

  it('switching to a template releases the design\'s images and card', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const { image, render, body } = await validSave(o);
    expect((await put(o, body)).status).toBe(200);
    const template = await put(o, { kind: 'TEMPLATE', templateId: 'wedding', templateVersion: 1, overrides: { elements: {} } });
    expect(template.status).toBe(200);
    expect(template.body.data).toMatchObject({ kind: 'TEMPLATE', document: null, svgMarkup: null, pngStoredFileId: null, editable: true });
    expect((await storedFile(image.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(render.publicId)).status).toBe('DELETE_REQUESTED');
  }, 60_000);
});

// ── 5. After a downgrade ──────────────────────────────────────

describe('after a downgrade', () => {
  it('guests still see the design; the organiser sees it not editable; saving is refused; reset works', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const { image, render, body } = await validSave(o);
    expect((await put(o, body)).status).toBe(200);

    await prisma.tenant.update({ where: { id: o.tenantId }, data: { subscriptionTier: 'SPARK' } });

    expect(await guestDesign(o)).toMatchObject({ kind: 'CANVAS', format: '4:5', hasRsvpButton: true });

    const got = await request(app).get(url(o.eventId)).set(headersFor(o.admin));
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ kind: 'CANVAS', document: body.document, editable: false });
    expect(got.body.data.notEditableReason).toMatch(/^The Spark plan doesn't include invitation designs/);

    const image2 = await designImage(o);
    const resave = await put(o, canvasBody(image2.url, render.publicId));
    expect(resave.status).toBe(403);
    expect(resave.body.code).toBe('INVITATION_DESIGNS_NOT_ON_PLAN');
    expect((await sign(o, 'ASSET')).status).toBe(403);

    const reset = await request(app).delete(url(o.eventId)).set(headersFor(o.admin));
    expect(reset.status).toBe(200);
    expect(reset.body.data).toBeNull();
    expect((await request(app).get(url(o.eventId)).set(headersFor(o.admin))).body.data).toBeNull();
    expect(await guestDesign(o)).toBeNull();
    expect(await prisma.invitationDesign.count({ where: { eventId: o.eventId, isArchived: true, kind: 'CANVAS' } })).toBe(1);
    expect((await storedFile(image.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(render.publicId)).status).toBe('DELETE_REQUESTED');

    // Resetting again is fine (nothing to reset).
    expect((await request(app).delete(url(o.eventId)).set(headersFor(o.admin))).status).toBe(200);
  }, 60_000);
});

// ── 6. What guests receive ────────────────────────────────────

describe('what guests receive', () => {
  it('a CANVAS design: exactly the card, never the document', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    const { render, body } = await validSave(o);
    expect((await put(o, body)).status).toBe(200);

    const design = await guestDesign(o);
    expect(Object.keys(design ?? {}).sort()).toEqual(['altText', 'envelopeColor', 'format', 'hasRsvpButton', 'kind', 'pngUrl', 'sealColor', 'svg'].sort());
    const { cloudName } = requireCloudinaryConfig();
    expect(design).toMatchObject({
      kind: 'CANVAS',
      format: '4:5',
      pngUrl: `https://res.cloudinary.com/${cloudName}/image/upload/${render.publicId}.png`,
      altText: 'Thandi and Sipho are getting married',
      envelopeColor: '#FAF7F2',
      sealColor: '#6C4CF1',
      hasRsvpButton: true,
    });
    // Nothing of the document: not its keys, not its editor-only fields.
    const json = JSON.stringify(design);
    for (const leak of ['"document"', '"objects"', 'egLabel', 'egId', 'documentVersion', '"version"', render.publicId.split('/').slice(0, -1).join('/') + '"']) {
      expect(json).not.toContain(leak);
    }
  }, 60_000);

  it('TEMPLATE and UPLOAD designs keep their shapes', async () => {
    const o = await organiserOn({ tier: 'ELEVATE' });
    expect((await put(o, { kind: 'TEMPLATE', templateId: 'wedding', templateVersion: 2, overrides: { elements: {} } })).status).toBe(200);
    expect(Object.keys((await guestDesign(o)) ?? {}).sort()).toEqual(['kind', 'overrides', 'templateId', 'templateVersion']);

    const up = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId: o.tenantId, eventId: o.eventId, uploadedBy: { userId: o.admin.id }, format: 'png' });
    expect((await put(o, { kind: 'UPLOAD', imageUrl: up.url, cloudinaryPublicId: up.publicId, width: 1080, height: 1350, altText: 'Card' })).status).toBe(200);
    expect(Object.keys((await guestDesign(o)) ?? {}).sort()).toEqual(['altText', 'height', 'imageUrl', 'kind', 'width']);
  }, 60_000);
});
