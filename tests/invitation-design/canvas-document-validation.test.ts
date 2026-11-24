import { describe, it, expect } from 'vitest';
import { assertValidCanvasDocument } from '../../src/modules/invitation-design/canvas-document-validation.util.js';
import { HttpError } from '../../src/shared/errors/http-error.js';
import { fabricCircle, fabricDocument, fabricImage, fabricLine, fabricRect, fabricRsvpButton, fabricText } from './canvas-fixtures.js';

// ─────────────────────────────────────────
//  THE DESIGN DOCUMENT (canvas-document-validation.util.ts)
//
//  A real Fabric 7.4 document passes as it is; every refusal is a 422 with
//  its own code. STORAGE_ENV is 'dev' in tests (tests/setup.ts).
// ─────────────────────────────────────────

const ctx = { cloudName: 'our-cloud', tenantId: 'T1', eventId: 'E1' };
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-1b2c-4d5e-8f90-123456789abc`;
const ourImage = (n = 1, ext = 'webp') => `https://res.cloudinary.com/our-cloud/image/upload/v1700000000/dev/t/T1/e/E1/design-asset/${uuid(n)}.${ext}`;

const check = (doc: unknown) => assertValidCanvasDocument(doc, ctx);
const refusal = (doc: unknown): HttpError => {
  try {
    check(doc);
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
};
const expectRefused = (doc: unknown, code: string, words?: string | RegExp) => {
  const err = refusal(doc);
  expect(err.statusCode).toBe(422);
  expect(err.code).toBe(code);
  if (words) expect(err.message).toMatch(words);
};
const withObjects = (...objects: unknown[]) => ({ version: '7.4.0', objects });

describe('a real Fabric 7.4 document', () => {
  it('passes, and what it uses is worked out from it', () => {
    const doc = fabricDocument(ourImage());
    const result = check(doc);
    expect(result.document).toBe(doc);
    expect(result.hasRsvpButton).toBe(true);
    expect(result.imageUrls).toEqual([ourImage()]);
    expect(result.imagePublicIds).toEqual([`dev/t/T1/e/E1/design-asset/${uuid(1)}`]);
    // 5 elements + the button and its 2 parts.
    expect(result.elementCount).toBe(8);
    expect(result.imageCount).toBe(1);
  });

  it('without an RSVP button, with a background image, every image format', () => {
    const doc = {
      ...fabricDocument(ourImage(1, 'jpg'), { rsvp: false }),
      backgroundImage: fabricImage(ourImage(2, 'png'), { width: 1080, height: 1920, scaleX: 1, scaleY: 1, left: 0 }),
    };
    const result = check(doc);
    expect(result.hasRsvpButton).toBe(false);
    expect(result.imageUrls.sort()).toEqual([ourImage(1, 'jpg'), ourImage(2, 'png')].sort());
    expect(result.imageCount).toBe(2);
  });

  it('every one of the ten fonts is allowed', () => {
    for (const font of ['Fraunces', 'Inter', 'Poppins', 'Playfair Display', 'Cormorant Garamond', 'Montserrat', 'Lora', 'DM Serif Display', 'Great Vibes', 'Dancing Script']) {
      expect(() => check(withObjects(fabricText({ fontFamily: font })))).not.toThrow();
    }
  });
});

describe('refusals', () => {
  it('a font that is not one of the ten', () => {
    expectRefused(withObjects(fabricText({ fontFamily: 'Comic Sans MS' })), 'DESIGN_FONT_NOT_ALLOWED', /isn't one of the available fonts/);
    // The template engine's Libre Baskerville isn't one of them.
    expectRefused(withObjects(fabricText({ fontFamily: 'Libre Baskerville' })), 'DESIGN_FONT_NOT_ALLOWED');
    // A font smuggled in as a CSS list, or missing.
    expectRefused(withObjects(fabricText({ fontFamily: 'Poppins, url(https://evil.example/f.woff)' })), 'DESIGN_FONT_NOT_ALLOWED');
    expectRefused(withObjects(fabricText({ fontFamily: undefined })), 'DESIGN_FONT_NOT_ALLOWED');
    // Inside the RSVP button too.
    const button = fabricRsvpButton();
    (button.objects[1] as Record<string, unknown>)['fontFamily'] = 'Arial';
    expectRefused(withObjects(button), 'DESIGN_FONT_NOT_ALLOWED');
  });

  it('an image from outside our Cloudinary account and this event\'s design folder', () => {
    const outside = [
      'https://evil.example/x.webp',
      ourImage().replace('our-cloud', 'their-cloud'),
      ourImage().replace('/e/E1/', '/e/E2/'),
      ourImage().replace('/t/T1/', '/t/T2/'),
      ourImage().replace('/design-asset/', '/design/'),
      ourImage().replace('/design-asset/', '/cover/'),
      ourImage().replace('/dev/', '/prod/'),
      ourImage().replace('/upload/', '/upload/e_blur/'),
      `${ourImage()}?x=1`,
      ourImage(1, 'svg'),
      ourImage().replace('https:', 'http:'),
      'data:image/png;base64,iVBORw0KGgo=',
      'javascript:alert(1)',
      `https://res.cloudinary.com/our-cloud/image/upload/v1/dev/t/T1/e/E1/design-asset/not-a-uuid.webp`,
    ];
    for (const src of outside) expectRefused(withObjects(fabricImage(src)), 'DESIGN_IMAGE_SOURCE_NOT_ALLOWED', /uploaded for this event's design/);
    // A background image too.
    expectRefused({ ...withObjects(), backgroundImage: fabricImage('https://evil.example/bg.webp') }, 'DESIGN_IMAGE_SOURCE_NOT_ALLOWED');
  });

  it('text drawn smaller than 36 units, by its size or its scale', () => {
    expectRefused(withObjects(fabricText({ fontSize: 35 })), 'DESIGN_TEXT_TOO_SMALL', /at least 36/);
    expectRefused(withObjects(fabricText({ fontSize: 40, scaleY: 0.5 })), 'DESIGN_TEXT_TOO_SMALL');
    // The button's label, shrunk with its group.
    expectRefused(withObjects(fabricRsvpButton({ scaleY: 0.5 })), 'DESIGN_TEXT_TOO_SMALL');
    // Exactly 36 is fine.
    expect(() => check(withObjects(fabricText({ fontSize: 36 })))).not.toThrow();
    expect(() => check(withObjects(fabricText({ fontSize: 18, scaleY: 2 })))).not.toThrow();
  });

  it('two RSVP buttons', () => {
    expectRefused(withObjects(fabricRsvpButton(), fabricRsvpButton({ egId: 'el10' })), 'DESIGN_RSVP_BUTTON_DUPLICATE', /only one RSVP button/);
  });

  it('more than 100 elements (the button\'s parts count)', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => fabricRect({ egId: `r${i}` }));
    expect(check(withObjects(...hundred)).elementCount).toBe(100);
    expectRefused(withObjects(...hundred, fabricRect()), 'DESIGN_TOO_MANY_ELEMENTS', /at most 100/);
    expectRefused(withObjects(...hundred.slice(0, 98), fabricRsvpButton()), 'DESIGN_TOO_MANY_ELEMENTS');
  });

  it('more than 10 images (the background image counts)', () => {
    const ten = Array.from({ length: 10 }, (_, i) => fabricImage(ourImage(i + 1)));
    expect(check(withObjects(...ten)).imageCount).toBe(10);
    expectRefused(withObjects(...ten, fabricImage(ourImage(11))), 'DESIGN_TOO_MANY_IMAGES', /at most 10 images/);
    expectRefused({ ...withObjects(...ten), backgroundImage: fabricImage(ourImage(11)) }, 'DESIGN_TOO_MANY_IMAGES');
    // The same image placed twice is two images.
    expectRefused(withObjects(...Array.from({ length: 11 }, () => fabricImage(ourImage(1)))), 'DESIGN_TOO_MANY_IMAGES');
  });

  it('a document over 200KB (an embedded image, or very long texts)', () => {
    const embedded = fabricImage(`data:image/png;base64,${'A'.repeat(210 * 1024)}`);
    expectRefused(withObjects(embedded), 'DESIGN_DOCUMENT_TOO_LARGE', /200KB/);
    expectRefused(withObjects(...Array.from({ length: 99 }, () => fabricText({ egLabel: 'x'.repeat(100), text: '€'.repeat(1000) }))), 'DESIGN_DOCUMENT_TOO_LARGE');
  });

  it('an element type that is not allowed', () => {
    for (const type of ['Path', 'Polygon', 'Polyline', 'Triangle', 'Ellipse', 'IText', 'Text', 'ActiveSelection', 'Image2', 'rect']) {
      expectRefused(withObjects({ ...fabricRect(), type }), 'DESIGN_ELEMENT_NOT_ALLOWED');
    }
    // A plain group, a group in the button, an image in the button.
    expectRefused(withObjects({ ...fabricRsvpButton(), egRole: undefined }), 'DESIGN_ELEMENT_NOT_ALLOWED');
    expectRefused(withObjects(fabricRsvpButton({ objects: [fabricText(), fabricRsvpButton()] })), 'DESIGN_ELEMENT_NOT_ALLOWED');
    expectRefused(withObjects(fabricRsvpButton({ objects: [fabricText(), fabricImage(ourImage())] })), 'DESIGN_ELEMENT_NOT_ALLOWED');
    // A role on anything else.
    expectRefused(withObjects(fabricRect({ egRole: 'rsvpButton' })), 'DESIGN_DOCUMENT_INVALID');
  });

  it('a colour that is not hex', () => {
    for (const fill of ['red', 'rgb(255,0,0)', '#fff', '#12345678', 'url(#g)', 'transparent']) {
      expectRefused(withObjects(fabricText({ fill })), 'DESIGN_COLOUR_INVALID', /#1F2937/);
    }
    expectRefused(withObjects(fabricRect({ stroke: 'rgb(0,0,0)' })), 'DESIGN_COLOUR_INVALID');
    expectRefused(withObjects(fabricCircle({ fill: 'hsl(0,0%,0%)' })), 'DESIGN_COLOUR_INVALID');
    expectRefused({ ...withObjects(), background: 'white' }, 'DESIGN_COLOUR_INVALID');
    // Fabric's own default fill is accepted only where nothing paints it.
    expect(() => check(withObjects(fabricLine(), fabricImage(ourImage())))).not.toThrow();
    expectRefused(withObjects(fabricRect({ fill: 'rgb(0,0,0)' })), 'DESIGN_COLOUR_INVALID');
  });

  it('an unknown setting, anywhere, is refused rather than dropped', () => {
    expectRefused(withObjects(fabricText({ onclick: 'alert(1)' })), 'DESIGN_DOCUMENT_INVALID', /'onclick'/);
    expectRefused(withObjects(fabricRect({ clipPath: { type: 'Rect' } })), 'DESIGN_DOCUMENT_INVALID', /'clipPath'/);
    expectRefused(withObjects(fabricText({ path: 'M0 0 L10 10' })), 'DESIGN_DOCUMENT_INVALID', /'path'/);
    expectRefused({ ...withObjects(), overlayImage: fabricImage(ourImage()) }, 'DESIGN_DOCUMENT_INVALID', /'overlayImage'/);
    expectRefused(JSON.parse('{"version":"7.4.0","objects":[],"__proto__":{"x":1}}'), 'DESIGN_DOCUMENT_INVALID', /__proto__/);
  });

  it('what Fabric could carry past these checks is pinned to harmless', () => {
    expectRefused(withObjects(fabricRect({ shadow: { color: '#000000', blur: 10 } })), 'DESIGN_DOCUMENT_INVALID', /'shadow'/);
    expectRefused(withObjects(fabricImage(ourImage(), { filters: [{ type: 'Blur' }] })), 'DESIGN_DOCUMENT_INVALID', /'filters'/);
    expectRefused(withObjects(fabricText({ styles: [{ start: 0, end: 1, style: { fontFamily: 'Arial', fontSize: 4 } }] })), 'DESIGN_DOCUMENT_INVALID', /'styles'/);
    expectRefused(withObjects(fabricRect({ globalCompositeOperation: 'xor' })), 'DESIGN_DOCUMENT_INVALID');
    expectRefused(withObjects(fabricText({ text: 'line\u0000break' })), 'DESIGN_DOCUMENT_INVALID', /plain text/);
    expectRefused(withObjects(fabricText({ text: 'x'.repeat(1001) })), 'DESIGN_DOCUMENT_INVALID', /1000 characters/);
    expectRefused(withObjects(fabricRect({ left: 1e9 })), 'DESIGN_DOCUMENT_INVALID');
    expectRefused(withObjects(fabricRect({ opacity: 'none' })), 'DESIGN_DOCUMENT_INVALID');
    expectRefused(withObjects(fabricText({ egSource: '<script>' })), 'DESIGN_DOCUMENT_INVALID');
  });

  it('not a document', () => {
    for (const doc of [null, 'x', [], { version: '7.4.0' }, { version: 'latest', objects: [] }, withObjects('rect'), withObjects(null)]) {
      expectRefused(doc, 'DESIGN_DOCUMENT_INVALID');
    }
  });
});
