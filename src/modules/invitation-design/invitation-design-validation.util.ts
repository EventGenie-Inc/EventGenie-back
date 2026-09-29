import { HttpError } from '../../shared/errors/http-error.js';
import { INVITATION_FONT_ALLOWLIST } from './invitation-design-fonts.js';
import { INVITATION_DESIGN_MAX_BYTES } from '../upload/upload-constants.js';
import { invitationDesignFolder, isCloudinaryDeliveryUrlFor, isSignedPublicIdInFolder } from '../upload/upload-folders.js';
import {
  type InvitationElementOverride,
  type InvitationOverrides,
  type PutInvitationDesignDto,
} from './invitation-design.types.js';

// ─────────────────────────────────────────
//  INVITATION DESIGN — SERVER-SIDE VALIDATION
//
//  Templates live in the frontend, so this cannot check that an elementId
//  exists in a given template. What it CAN guarantee is the shape and the
//  safety of everything stored: every key is on an allowlist, every value
//  has a fixed format, and nothing resembling CSS or markup is accepted
//  anywhere. An unknown key anywhere is a 422, not ignored: silently
//  dropping it would let a client believe a style was saved.
//
//  Every failure is 422 with a message an organiser can act on.
// ─────────────────────────────────────────

// 20KB serialised. A real override set is ~100 bytes per element; the
// wedding template has 10 text elements, so even every property on every
// element with 300-character texts is ~5KB. 20KB leaves room for larger
// future templates while keeping a hostile payload from bloating the row
// every guest's validate() response carries.
export const INVITATION_OVERRIDES_MAX_BYTES = 20 * 1024;

// Font sizes are in the TEMPLATE'S OWN canvas units (the SVG viewBox; the
// wedding frame is 1080x1350), not CSS pixels: the card scales as a whole.
// The template itself uses 14-60. 10 is the floor because the card is
// shown at about a third of its canvas width on a phone, so 10 units is
// already about 3.5 CSS px, fine print at best; anything smaller is
// invisible. 200 is the ceiling because at 200 units only about 5
// characters of a heading fit across the 1080-unit card, so anything
// larger cannot hold even a short name without overflowing.
export const INVITATION_FONT_SIZE_MIN = 10;
export const INVITATION_FONT_SIZE_MAX = 200;

export const INVITATION_TEXT_MAX_CHARS = 300;
export const INVITATION_ALT_TEXT_MAX_CHARS = 300;

// Element ids come from the template SVGs' own `id` attributes, which are
// designer-chosen and contain spaces, colons and brackets (e.g.
// "day:date(dd month yyyy)"), so they are NOT slugs. Bounded in length and
// free of control characters. The three prototype names are refused: they
// have no business being an element id and are the classic way into an
// object's prototype once a client copies this map around.
const ELEMENT_ID_MAX_CHARS = 100;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_ELEMENT_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const TEMPLATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEMPLATE_ID_MAX_CHARS = 64;
// templateVersion is an INTEGER column; anything larger is a 500 at write.
const POSTGRES_INT_MAX = 2147483647;

const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// A sanity ceiling on reported pixel dimensions, far beyond any real
// design (A3 at 600dpi is ~7000x9900).
const IMAGE_DIMENSION_MAX = 20000;

const ELEMENT_OVERRIDE_KEYS: ReadonlySet<string> = new Set(['color', 'backgroundColor', 'fontFamily', 'fontSize', 'text']);
const FONT_ALLOWLIST: ReadonlySet<string> = new Set(INVITATION_FONT_ALLOWLIST);

const TEMPLATE_BODY_KEYS: ReadonlySet<string> = new Set(['kind', 'templateId', 'templateVersion', 'overrides']);
const UPLOAD_BODY_KEYS: ReadonlySet<string> = new Set(['kind', 'imageUrl', 'cloudinaryPublicId', 'width', 'height', 'altText', 'bytes']);

const invalid = (message: string): HttpError => new HttpError(422, message);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertOnlyKeys = (obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void => {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalid(
      `${where} has ${unknown.length === 1 ? 'a setting' : 'settings'} that can't be saved: ${unknown.map((k) => `'${k}'`).join(', ')}. ` +
      `Only ${[...allowed].join(', ')} are allowed.`
    );
  }
};

const assertColour = (value: unknown, field: string, elementId: string): void => {
  if (typeof value !== 'string' || !HEX_COLOUR_PATTERN.test(value)) {
    throw invalid(`The ${field} for '${elementId}' must be a colour like #1f2937 (a # followed by six hex digits).`);
  }
};

const assertElementOverride = (elementId: string, value: unknown): void => {
  if (!isPlainObject(value)) {
    throw invalid(`The settings for '${elementId}' must be an object.`);
  }
  assertOnlyKeys(value, ELEMENT_OVERRIDE_KEYS, `The design element '${elementId}'`);

  const o = value as InvitationElementOverride & Record<string, unknown>;
  if (o.color !== undefined) assertColour(o.color, 'colour', elementId);
  if (o.backgroundColor !== undefined) assertColour(o.backgroundColor, 'background colour', elementId);

  if (o.fontFamily !== undefined && (typeof o.fontFamily !== 'string' || !FONT_ALLOWLIST.has(o.fontFamily))) {
    throw invalid(`'${String(o.fontFamily)}' isn't one of the available fonts. Choose from: ${INVITATION_FONT_ALLOWLIST.join(', ')}.`);
  }

  if (o.fontSize !== undefined) {
    if (typeof o.fontSize !== 'number' || !Number.isFinite(o.fontSize)
      || o.fontSize < INVITATION_FONT_SIZE_MIN || o.fontSize > INVITATION_FONT_SIZE_MAX) {
      throw invalid(`The text size for '${elementId}' must be a number between ${INVITATION_FONT_SIZE_MIN} and ${INVITATION_FONT_SIZE_MAX}.`);
    }
  }

  if (o.text !== undefined) {
    if (typeof o.text !== 'string') {
      throw invalid(`The text for '${elementId}' must be plain text.`);
    }
    // Counted in characters as a person sees them (code points), not
    // UTF-16 units, so an emoji counts as one.
    if ([...o.text].length > INVITATION_TEXT_MAX_CHARS) {
      throw invalid(`The text for '${elementId}' is too long. Keep it to ${INVITATION_TEXT_MAX_CHARS} characters or fewer.`);
    }
  }
};

export const assertValidOverrides = (overrides: unknown): InvitationOverrides => {
  if (!isPlainObject(overrides)) {
    throw invalid('The design changes must be sent as { elements: { ... } }.');
  }
  // Size first: bounds the work the key-by-key checks below can be made to do.
  const bytes = Buffer.byteLength(JSON.stringify(overrides), 'utf8');
  if (bytes > INVITATION_OVERRIDES_MAX_BYTES) {
    throw invalid(`These design changes are too large to save (${Math.ceil(bytes / 1024)}KB; the limit is ${INVITATION_OVERRIDES_MAX_BYTES / 1024}KB).`);
  }

  assertOnlyKeys(overrides, new Set(['elements']), 'The design changes');
  const { elements } = overrides;
  if (!isPlainObject(elements)) {
    throw invalid('The design changes must be sent as { elements: { ... } }.');
  }

  for (const [elementId, value] of Object.entries(elements)) {
    if (elementId.trim().length === 0 || elementId.length > ELEMENT_ID_MAX_CHARS
      || CONTROL_CHARS.test(elementId) || FORBIDDEN_ELEMENT_IDS.has(elementId)) {
      throw invalid(`'${elementId.slice(0, ELEMENT_ID_MAX_CHARS)}' isn't a valid design element name.`);
    }
    assertElementOverride(elementId, value);
  }

  return { elements: elements as InvitationOverrides['elements'] };
};

// The publicId must be one this backend signed for THIS event
// (upload-signature generates `<folder>/<uuid>`), which stops one event's
// design pointing at another event's or tenant's asset; and the imageUrl
// must be our Cloudinary delivery URL for exactly that publicId, so the
// two cannot disagree. See upload-folders.ts for both checks.
const assertUploadLocation = (imageUrl: unknown, publicId: unknown, ctx: { cloudName: string; tenantId: string; eventId: string }): void => {
  const folder = invitationDesignFolder(ctx.tenantId, ctx.eventId);

  if (!isSignedPublicIdInFolder(publicId, folder)) {
    throw invalid("This image wasn't uploaded for this event. Upload it again from this event's design page.");
  }

  if (!isCloudinaryDeliveryUrlFor(imageUrl, {
    cloudName: ctx.cloudName, resourceType: 'image', publicId, extensions: ['jpg', 'jpeg', 'png', 'webp'],
  })) {
    throw invalid("The image link must be the one EventGenie's uploader returned for this image. Upload it again from this event's design page.");
  }
};

const assertDimension = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > IMAGE_DIMENSION_MAX) {
    throw invalid(`The image ${name} must be a whole number of pixels between 1 and ${IMAGE_DIMENSION_MAX}.`);
  }
  return value;
};

export const assertValidDesignInput = (
  body: unknown,
  ctx: { cloudName: string; tenantId: string; eventId: string }
): PutInvitationDesignDto => {
  if (!isPlainObject(body)) {
    throw invalid("Send the design as { kind: 'TEMPLATE', ... } or { kind: 'UPLOAD', ... }.");
  }

  if (body['kind'] === 'TEMPLATE') {
    assertOnlyKeys(body, TEMPLATE_BODY_KEYS, 'A template design');

    const { templateId, templateVersion } = body;
    if (typeof templateId !== 'string' || templateId.length > TEMPLATE_ID_MAX_CHARS || !TEMPLATE_ID_PATTERN.test(templateId)) {
      throw invalid('The template name must be lowercase letters, numbers and single dashes, e.g. "wedding-classic".');
    }
    if (typeof templateVersion !== 'number' || !Number.isInteger(templateVersion) || templateVersion < 1 || templateVersion > POSTGRES_INT_MAX) {
      throw invalid('The template version must be a whole number of 1 or more.');
    }
    const overrides = assertValidOverrides(body['overrides']);
    return { kind: 'TEMPLATE', templateId, templateVersion, overrides };
  }

  if (body['kind'] === 'UPLOAD') {
    assertOnlyKeys(body, UPLOAD_BODY_KEYS, 'An uploaded design');

    assertUploadLocation(body['imageUrl'], body['cloudinaryPublicId'], ctx);
    const width = assertDimension(body['width'], 'width');
    const height = assertDimension(body['height'], 'height');

    const bytes = body['bytes'];
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
      throw invalid("The image's file size is missing. Upload it again from this event's design page.");
    }
    if (bytes > INVITATION_DESIGN_MAX_BYTES) {
      throw invalid(
        `This image is too large (${(bytes / (1024 * 1024)).toFixed(1)}MB). Invitation designs must be ` +
        `${INVITATION_DESIGN_MAX_BYTES / (1024 * 1024)}MB or smaller. Try exporting it as a JPG, or at a smaller size.`
      );
    }

    let altText: string | null = null;
    const rawAlt = body['altText'];
    if (rawAlt !== undefined && rawAlt !== null) {
      if (typeof rawAlt !== 'string') throw invalid('The image description must be plain text.');
      const trimmed = rawAlt.trim();
      if ([...trimmed].length > INVITATION_ALT_TEXT_MAX_CHARS) {
        throw invalid(`The image description is too long. Keep it to ${INVITATION_ALT_TEXT_MAX_CHARS} characters or fewer.`);
      }
      altText = trimmed.length > 0 ? trimmed : null;
    }

    return {
      kind: 'UPLOAD',
      imageUrl: body['imageUrl'] as string,
      cloudinaryPublicId: body['cloudinaryPublicId'] as string,
      width,
      height,
      altText,
      bytes,
    };
  }

  throw invalid("The design kind must be 'TEMPLATE' or 'UPLOAD'.");
};
