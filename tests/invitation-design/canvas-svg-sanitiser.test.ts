import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { cleanCanvasSvg } from '../../src/modules/invitation-design/canvas-svg-sanitiser.util.js';
import { HttpError } from '../../src/shared/errors/http-error.js';
import { CANVAS_SVG_MAX_BYTES } from '../../src/modules/invitation-design/canvas-design.constants.js';
import { PIN_SVG, fabricSvg, svgAround } from './canvas-fixtures.js';

// ─────────────────────────────────────────
//  CLEANING A DESIGN'S SVG (canvas-svg-sanitiser.util.ts)
//
//  Every known way to run script or load something from an SVG shown
//  inline on a page is removed, and a real Fabric 7.4 export passes with its
//  content unchanged. Nothing reaches the network: these are pure.
// ─────────────────────────────────────────

const OUR_IMAGE = 'https://res.cloudinary.com/our-cloud/image/upload/v1700000000/dev/t/T1/e/E1/design-asset/0f8c2a3e-1b2c-4d5e-8f90-123456789abc.webp';
const OTHER_EVENT_IMAGE = 'https://res.cloudinary.com/our-cloud/image/upload/v1700000000/dev/t/T1/e/E2/design-asset/1f8c2a3e-1b2c-4d5e-8f90-123456789abc.webp';

const clean = (svg: string, opts: { hasRsvpButton?: boolean; format?: '4:5' | '9:16'; images?: string[] } = {}) =>
  cleanCanvasSvg(svg, { format: opts.format ?? '4:5', allowedImageUrls: new Set(opts.images ?? [OUR_IMAGE]), hasRsvpButton: opts.hasRsvpButton ?? false });

const refusal = (fn: () => unknown): HttpError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
};

// The SVG as a browser would build it from HTML (the guest page inlines
// it): every element, attribute and non-blank text, in order. <desc> is
// left out (it is never drawn), and attribute values are compared trimmed
// (DOMPurify trims them; Fabric writes `transform=" translate(...)"`).
interface Canonical { tag: string; attrs: [string, string][]; children: (Canonical | string)[] }
const canonical = (markup: string): Canonical => {
  const doc = new JSDOM(`<!doctype html><body>${markup}`).window.document;
  const walk = (el: Element): Canonical => ({
    tag: el.nodeName,
    attrs: Array.from(el.attributes).map((a) => [a.name, a.value.trim()] as [string, string]).sort(),
    children: Array.from(el.childNodes).flatMap((n): (Canonical | string)[] => {
      if (n.nodeType === 3) return n.textContent!.trim() ? [n.textContent!] : [];
      if (n.nodeType === 1 && n.nodeName !== 'desc') return [walk(n as Element)];
      return [];
    }),
  });
  return walk(doc.querySelector('svg')!);
};

describe('a clean Fabric export', () => {
  it('passes with its content unchanged (4:5), and nothing is reported stripped', () => {
    const input = fabricSvg(OUR_IMAGE);
    const { svg, stripped } = clean(input, { hasRsvpButton: true });
    expect(stripped).toEqual([]);
    expect(canonical(svg)).toEqual(canonical(input));
    // What it is made of, kept: the image link, the paint, the text, the marker.
    expect(svg).toContain(`xlink:href="${OUR_IMAGE}"`);
    expect(svg).toContain('style="stroke: rgb(244,185,66); stroke-width: 3;');
    expect(svg).toContain('font-family="Great Vibes"');
    expect(svg).toContain('Thandi &amp;');
    expect(svg).toContain('data-evelope-action="rsvp"');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('passes unchanged in 9:16, and without an RSVP button', () => {
    const input = fabricSvg(OUR_IMAGE, { format: '9:16', rsvp: false });
    const { svg, stripped } = clean(input, { format: '9:16' });
    expect(stripped).toEqual([]);
    expect(canonical(svg)).toEqual(canonical(input));
  });

  it('keeps a cropped image (its clipPath and a local url(#id) reference) and a gradient', () => {
    const body = `<g transform="matrix(-1.9319 -0.5176 -0.5176 1.9319 10.3277 20.709)"  >
<clipPath id="imageCrop_2">
\t<rect x="-0.25" y="-0.3" width="0.5" height="0.6" />
</clipPath>
\t<image style="stroke: none; fill: rgb(0,0,0); opacity: 1;"  xlink:href="${OUR_IMAGE}" x="-0.45" y="-0.4" width="1" height="1" clip-path="url(#imageCrop_2)" ></image>
</g>
<defs><linearGradient id="SVGID_1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0%" style="stop-color: rgb(255,0,0); stop-opacity: 1"/></linearGradient></defs>
<rect x="0" y="0" width="10" height="10" style="fill: url(#SVGID_1);" />`;
    const input = fabricSvg(OUR_IMAGE, { body, rsvp: false });
    const { svg, stripped } = clean(input);
    expect(stripped).toEqual([]);
    expect(canonical(svg)).toEqual(canonical(input));
  });
});

// Each: the payload, and what must not survive anywhere in the output.
// inert: made harmless by the parser alone, with nothing to strip (CDATA in
// an SVG is text, so its "tags" come out escaped).
const ATTACKS: { name: string; svg: string; never: RegExp[]; inert?: true }[] = [
  // ── script tags ──
  { name: 'a script element', svg: svgAround('<script>alert(1)</script><rect width="1" height="1"/>'), never: [/<script/i, /alert/] },
  { name: 'a script element with an xlink:href', svg: svgAround('<script xlink:href="https://evil.example/x.js"></script>'), never: [/<script/i, /evil/] },
  { name: 'a script inside an allowed element', svg: svgAround('<g><text>hi<script>alert(1)</script></text></g>'), never: [/<script/i, /alert/] },
  // ── event handlers ──
  { name: 'onload on the svg', svg: '<svg viewBox="0 0 1080 1350" onload="alert(1)"><rect width="1" height="1"/></svg>', never: [/onload/i, /alert/] },
  { name: 'onclick, onmouseover, ONERROR on shapes and images', svg: svgAround(`<rect onclick="alert(1)" onmouseover="alert(2)" width="1" height="1"/><image xlink:href="${OUR_IMAGE}" ONERROR="alert(3)"/>`), never: [/\son[a-z]+=/i, /alert/] },
  { name: 'onbegin on an animation', svg: svgAround('<animate onbegin="alert(1)" attributeName="x" dur="1s"/>'), never: [/onbegin/i, /animate/i, /alert/] },
  // ── javascript: hrefs ──
  { name: 'javascript: in an image href', svg: svgAround('<image href="javascript:alert(1)"/><image xlink:href=" JaVaScRiPt:alert(2)"/>'), never: [/javascript/i, /alert/] },
  { name: 'javascript: in an <a> (with its content)', svg: svgAround('<a href="javascript:alert(1)"><text>click</text></a><a xlink:href="javascript:alert(2)"><rect width="1" height="1"/></a>'), never: [/javascript/i, /alert/, /<a[\s>]/, /click/] },
  { name: 'an entity-encoded javascript: href', svg: svgAround('<image href="&#106;avascript:alert(1)"/><image href="java&#x09;script:alert(2)"/>'), never: [/javascript/i, /java\s*script/i, /alert/] },
  // ── foreignObject ──
  { name: 'foreignObject with HTML', svg: svgAround('<foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/><iframe src="https://evil.example"></iframe><p>hello</p></body></foreignObject>'), never: [/foreignobject/i, /<img/i, /<iframe/i, /onerror/i, /alert/, /evil/, /hello/] },
  // ── external images ──
  { name: 'an image from another site', svg: svgAround('<image href="https://evil.example/x.png"/><image xlink:href="//evil.example/y.png"/><image xlink:href="http://evil.example/z.png"/>'), never: [/evil/] },
  { name: "an image from another event's folder, or another Cloudinary account", svg: svgAround(`<image xlink:href="${OTHER_EVENT_IMAGE}"/><image xlink:href="${OUR_IMAGE.replace('our-cloud', 'their-cloud')}"/>`), never: [/E2\/design-asset/, /their-cloud/] },
  { name: 'our image with a query or a transformation added', svg: svgAround(`<image xlink:href="${OUR_IMAGE}?x=1"/><image xlink:href="${OUR_IMAGE.replace('/upload/', '/upload/e_blur/')}"/>`), never: [/\?x=1/, /e_blur/] },
  { name: 'a data: image', svg: svgAround('<image href="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"/>'), never: [/data:/] },
  // ── use / xlink pointing elsewhere ──
  { name: 'use pointing at another file', svg: svgAround('<use href="https://evil.example/sprite.svg#a"/><use xlink:href="https://evil.example/sprite.svg#b"/>'), never: [/<use/i, /evil/] },
  { name: 'use with a data: URL, and a local use', svg: svgAround('<rect id="r" width="1" height="1"/><use xlink:href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/><use href="#r"/>'), never: [/<use/i, /data:/] },
  { name: 'an xlink:href on a shape or group', svg: svgAround('<g xlink:href="https://evil.example/"><rect href="https://evil.example/" width="1" height="1"/></g>'), never: [/evil/, /href/] },
  // ── CSS with url() ──
  { name: 'style with an external url()', svg: svgAround('<rect width="1" height="1" style="fill: url(https://evil.example/x#a); stroke: #000000"/>'), never: [/evil/, /url\(/] },
  { name: 'style with url(javascript:), behavior and expression', svg: svgAround('<rect width="1" height="1" style="background-image: url(javascript:alert(1)); behavior: url(x.htc); width: expression(alert(2))"/>'), never: [/javascript/i, /alert/, /url\(/, /expression/, /behavior/] },
  { name: 'style with quotes, escapes and @import', svg: svgAround('<rect width="1" height="1" style="fill: url(&quot;https://evil.example&quot;); stroke: u\\72l(https://evil.example/b); @import url(https://evil.example/c.css)"/>'), never: [/evil/, /\\72/, /@import/] },
  { name: 'a presentation attribute with an external url()', svg: svgAround('<rect width="1" height="1" fill="url(https://evil.example/x#g)" clip-path="url(http://evil.example/#c)" stroke="url(javascript:alert(1))"/>'), never: [/evil/, /javascript/i, /url\(/] },
  { name: 'a style element and @font-face', svg: svgAround('<style>@font-face { font-family: X; src: url(https://evil.example/f.woff) } rect { fill: url(https://evil.example/y) }</style><rect width="1" height="1"/>'), never: [/<style/i, /font-face/i, /evil/] },
  { name: 'a font-family that is not one of ours, or holds a url', svg: svgAround('<text font-family="Comic Sans MS">a</text><text style="font-family: url(https://evil.example/f.woff)">b</text><text font-family="Poppins, url(https://evil.example)">c</text>'), never: [/Comic/, /evil/] },
  // ── entity tricks ──
  { name: 'a DOCTYPE entity that expands to a script', svg: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg viewBox="0 0 1080 1350"><text>&x;</text></svg>`, never: [/<script/i, /alert/, /ENTITY/] },
  { name: 'an external entity (file and URL)', svg: `<!DOCTYPE svg [<!ENTITY f SYSTEM "file:///etc/passwd"><!ENTITY u SYSTEM "https://evil.example/x">]><svg viewBox="0 0 1080 1350"><text>&f;&u;</text></svg>`, never: [/passwd/, /evil/, /SYSTEM/] },
  { name: 'billion laughs', svg: `<!DOCTYPE svg [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]><svg viewBox="0 0 1080 1350"><text>&d;</text></svg>`, never: [/lollol/, /ENTITY/] },
  { name: 'CDATA closing a tag early', svg: svgAround('<text><![CDATA[</text><script>alert(1)</script>]]></text>'), never: [/<script/i, /<\/text><script/], inert: true },
  // ── animation and other elements ──
  { name: 'animate / set changing a link', svg: svgAround('<a><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="javascript:alert(2)"/><text>x</text></a>'), never: [/<set/i, /<animate/i, /javascript/i] },
  { name: 'iframe, embed and object', svg: svgAround('<iframe src="https://evil.example"></iframe><embed src="https://evil.example"/><object data="https://evil.example"></object>'), never: [/iframe|embed|object/i, /evil/] },
  { name: 'a filter, pattern, mask, marker or symbol', svg: svgAround('<filter id="f"><feImage href="https://evil.example/x.png"/></filter><pattern id="p"><image href="https://evil.example/y.png"/></pattern><mask id="m"/><marker id="k"/><symbol id="s"/>'), never: [/filter|feimage|pattern|mask|marker|symbol/i, /evil/] },
  { name: 'the RSVP marker on something other than a group, or with another value', svg: svgAround('<rect data-evelope-action="rsvp" width="1" height="1"/><g data-evelope-action="javascript:alert(1)"></g><g data-other="x" data-evelope-action="RSVP"></g>'), never: [/data-/, /javascript/] },
  // ── mXSS-style breakouts ──
  { name: 'a title or style breaking out of the SVG', svg: svgAround('<title><a id="</title><img src=x onerror=alert(1)>"></a></title><style><img src=x onerror=alert(2)></style>'), never: [/<img/i, /onerror/i, /alert/] },
];

describe('attack payloads: none survives', () => {
  for (const attack of ATTACKS) {
    it(attack.name, () => {
      const { svg, stripped } = clean(attack.svg);
      for (const pattern of attack.never) expect(svg, `${attack.name}: ${pattern}`).not.toMatch(pattern);
      // The single root is all that is left, and a parse of it finds no
      // handler, no foreign link and no script anywhere.
      const doc = new JSDOM(`<!doctype html><body>${svg}`).window.document;
      expect(doc.body.children).toHaveLength(1);
      expect(doc.querySelectorAll('script, foreignObject, use, a, iframe, style, animate, set')).toHaveLength(0);
      for (const el of Array.from(doc.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name).not.toMatch(/^on/i);
          if (/href$/i.test(attr.name)) expect(attr.value).toBe(OUR_IMAGE);
        }
      }
      // Something was removed, and the log line lists its kind.
      if (!attack.inert) expect(stripped.length).toBeGreaterThan(0);
      for (const kind of stripped) expect(kind).toMatch(/^(element|attribute|style|text):[a-z0-9:#*_-]+$/);
    });
  }

  it('reports what it stripped by kind, never by content', () => {
    const { stripped } = clean(svgAround('<script>alert("secret")</script><rect onload="steal()" width="1" height="1" style="fill: url(https://evil.example/x)"/>'));
    // The style held only a bad declaration, so the attribute went too.
    expect(stripped).toEqual(['attribute:on*', 'attribute:style', 'element:script', 'style:fill']);
    expect(stripped.join(' ')).not.toMatch(/secret|steal|evil/);
  });
});

describe('the card must be usable', () => {
  it('the viewBox must match the format', () => {
    expect(refusal(() => clean(fabricSvg(OUR_IMAGE, { rsvp: false }), { format: '9:16' })).code).toBe('DESIGN_SVG_VIEWBOX_MISMATCH');
    expect(refusal(() => clean(fabricSvg(OUR_IMAGE, { format: '9:16', rsvp: false }), { format: '4:5' })).code).toBe('DESIGN_SVG_VIEWBOX_MISMATCH');
    expect(refusal(() => clean(fabricSvg(OUR_IMAGE, { rsvp: false, viewBox: '0 0 1080 1351' }))).code).toBe('DESIGN_SVG_VIEWBOX_MISMATCH');
    expect(refusal(() => clean('<svg><rect width="1" height="1"/></svg>')).code).toBe('DESIGN_SVG_VIEWBOX_MISMATCH');
    // Commas are a valid separator.
    expect(clean(fabricSvg(OUR_IMAGE, { rsvp: false, viewBox: '0,0,1080,1350' })).stripped).toEqual([]);
  });

  it('the cleaned SVG must be within 300KB, and the sent one within 1MB', () => {
    // ~350KB of plain rects: allowed content, too large once cleaned.
    const many = Array.from({ length: 5000 }, (_, i) => `<rect x="${i}" y="${i}" width="10" height="10" fill="#1F2937"/>`).join('');
    const big = svgAround(many);
    expect(Buffer.byteLength(big)).toBeGreaterThan(CANVAS_SVG_MAX_BYTES);
    expect(Buffer.byteLength(big)).toBeLessThan(1024 * 1024);
    const tooLarge = refusal(() => clean(big));
    expect(tooLarge.code).toBe('DESIGN_SVG_TOO_LARGE');
    expect(tooLarge.message).toContain('300KB');

    // Just under: fine.
    const fits = svgAround(Array.from({ length: 3000 }, (_, i) => `<rect x="${i}" y="${i}" width="10" height="10" fill="#1F2937"/>`).join(''));
    expect(Buffer.byteLength(clean(fits).svg)).toBeLessThanOrEqual(CANVAS_SVG_MAX_BYTES);

    // Over 1MB is refused before it is parsed, even when cleaning would
    // shrink it to almost nothing (here, a 1MB script).
    const padded = svgAround('<script>' + 'x'.repeat(1024 * 1024) + '</script>');
    expect(Buffer.byteLength(clean(svgAround('<script>' + 'x'.repeat(1000) + '</script>')).svg)).toBeLessThan(1000);
    expect(refusal(() => clean(padded)).code).toBe('DESIGN_SVG_TOO_LARGE');
  });

  it('must be one SVG', () => {
    expect(refusal(() => clean('')).code).toBe('DESIGN_SVG_INVALID');
    expect(refusal(() => clean('<div>not an svg</div>')).code).toBe('DESIGN_SVG_INVALID');
    expect(refusal(() => clean(svgAround('') + svgAround(''))).code).toBe('DESIGN_SVG_INVALID');
    expect(refusal(() => cleanCanvasSvg(42, { format: '4:5', allowedImageUrls: new Set(), hasRsvpButton: false })).code).toBe('DESIGN_SVG_INVALID');
  });

  it('the RSVP marker must match the document: once with a button, never without', () => {
    // A button in the document, none marked in the picture.
    expect(refusal(() => clean(fabricSvg(OUR_IMAGE, { rsvp: false }), { hasRsvpButton: true })).code).toBe('DESIGN_SVG_RSVP_MISMATCH');
    // Marked, with no button in the document.
    expect(refusal(() => clean(fabricSvg(OUR_IMAGE), { hasRsvpButton: false })).code).toBe('DESIGN_SVG_RSVP_MISMATCH');
    // Marked twice.
    const twice = svgAround('<g data-evelope-action="rsvp"></g><g data-evelope-action="rsvp"></g>');
    expect(refusal(() => clean(twice, { hasRsvpButton: true })).code).toBe('DESIGN_SVG_RSVP_MISMATCH');
  });
});

describe('paths', () => {
  it("Fabric's own path passes unchanged, as do every command and number form", () => {
    const input = fabricSvg(OUR_IMAGE, { rsvp: false, body: PIN_SVG });
    const { svg, stripped } = clean(input);
    expect(stripped).toEqual([]);
    expect(canonical(svg)).toEqual(canonical(input));
    for (const d of ['M0,0L10,10z', 'm 1.5e2 -3 h 4 v -5 c 1 2 3 4 5 6 s 1 2 3 4 q 1 2 3 4 t 1 2 a 5 5 0 1 0 10 10 Z', 'M.5.5L-1-1', 'M 1 2\n L 3 4']) {
      const one = clean(svgAround(`<path d="${d}"/>`));
      expect(one.stripped, d).toEqual([]);
      expect(one.svg).toContain('d="');
    }
  });

  it('a d with letters outside the commands, a payload, or over 20KB is stripped', () => {
    for (const d of [
      'M 0 0 X 10 10',
      'M 0 0 L 10 10 javascript:alert(1)',
      'javascript:alert(1)',
      'M 0 0 url(https://evil.example/x)',
      'M 0 0 L 10 10"/><script>alert(1)</script>',
      'M 0 0; fill: url(https://evil.example)',
      'M 0 0 &#x6a;avascript',
      '10 10 L 20 20',
      'M 0 0 L 1e',
    ]) {
      const { svg, stripped } = clean(svgAround(`<path d='${d}' fill="#1F2937"/>`));
      expect(svg, d).not.toMatch(/\sd=/);
      expect(svg, d).not.toMatch(/javascript|evil|<script|alert/i);
      expect(stripped, d).toContain('attribute:d');
    }
    const big = `M 0 0 ${Array.from({ length: 2000 }, (_, i) => `L ${i}.123 ${i}.456`).join(' ')}`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(20 * 1024);
    const { svg, stripped } = clean(svgAround(`<path d="${big}"/>`));
    expect(svg).not.toMatch(/\sd=/);
    expect(stripped).toContain('attribute:d');
  });

  it('a d on anything but a path is stripped', () => {
    const { svg, stripped } = clean(svgAround('<rect d="M 0 0 L 1 1" width="1" height="1"/>'));
    expect(svg).not.toMatch(/\sd=/);
    expect(stripped).toContain('attribute:d');
  });
});
