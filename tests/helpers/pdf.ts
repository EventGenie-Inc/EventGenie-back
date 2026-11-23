import zlib from 'zlib';
import jsQRModule, { type QRCode } from 'jsqr';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib';

// ─────────────────────────────────────────
//  READING A PDF IN TESTS (pdf-lib's output)
//
//  pdfPagesOf opens a PDF made by pdf-lib and, per page, lists the images the
//  page draws (each with its object reference, pixel size, where and how big
//  it is drawn, and what it decodes to as a QR, read the way a phone would)
//  and the text it draws, line by line with where it sits and how far its ink
//  reaches. pdf-lib writes an image as FlateDecode RGB (its alpha in a
//  separate SMask) and text as hex strings in WinAnsi.
// ─────────────────────────────────────────

// jsqr's default import is the function at run time; its types say module.
const jsQR = jsQRModule as unknown as (data: Uint8ClampedArray, width: number, height: number) => QRCode | null;

export interface PdfPageImage {
  ref: string; // the image object's reference: the same object on two pages is one embed
  pixelWidth: number;
  pixelHeight: number;
  // Where it is drawn, in points (the `cm` before its `Do`).
  x: number;
  y: number;
  width: number;
  height: number;
  qr: string | null;
}

// One drawn line of text, measured here with the standard font's own metrics
// (not the code that laid it out): its baseline, the lowest its ink reaches
// (baseline less the font's descender) and its right edge.
export interface PdfTextRun {
  text: string;
  font: 'Helvetica' | 'Helvetica-Bold';
  size: number;
  x: number;
  y: number;
  bottom: number;
  top: number;
  right: number;
}

export interface PdfPage {
  images: PdfPageImage[];
  text: string[];
  runs: PdfTextRun[];
}

// WinAnsi's codes 0x80–0x9F that pdf-lib writes for typographic characters.
const WIN_ANSI: Record<number, string> = { 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };
const winAnsi = (hex: string): string => [...Buffer.from(hex, 'hex')].map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');

const measuringFonts = async () => {
  const doc = await PDFDocument.create();
  return { Helvetica: await doc.embedFont(StandardFonts.Helvetica), 'Helvetica-Bold': await doc.embedFont(StandardFonts.HelveticaBold) };
};

const streamBytes = (stream: PDFRawStream): Buffer => {
  const filter = stream.dict.lookup(PDFName.of('Filter'))?.toString();
  return filter === '/FlateDecode' ? zlib.inflateSync(Buffer.from(stream.contents)) : Buffer.from(stream.contents);
};

const decodeQr = (stream: PDFRawStream, width: number, height: number): string | null => {
  const pixels = streamBytes(stream);
  const channels = pixels.length / (width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = channels === 1 ? [pixels[i]!, pixels[i]!, pixels[i]!] : [pixels[i * 3]!, pixels[i * 3 + 1]!, pixels[i * 3 + 2]!];
    rgba.set([...v, 255], i * 4);
  }
  return jsQR(rgba, width, height)?.data ?? null;
};

export const pdfPagesOf = async (bytes: Buffer | Uint8Array): Promise<PdfPage[]> => {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages().map((page): PdfPage => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((ref) => pdf.context.lookup(ref) as PDFRawStream)
      : contents ? [contents as unknown as PDFRawStream] : [];
    const ops = streams.map((s) => streamBytes(s).toString('latin1')).join('\n');

    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const images: PdfPageImage[] = [];
    // pdf-lib draws an image as "q", then translate, rotate/skew and scale
    // as separate `cm`s, "/Name Do", "Q": their product places it.
    const draws: { name: string; m: number[] }[] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    for (const line of ops.split('\n').map((l) => l.trim())) {
      if (line === 'q') ctm = [1, 0, 0, 1, 0, 0];
      const cm = line.match(/^([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm$/);
      if (cm) {
        const [a, b, c, d, e, f] = cm.slice(1).map(Number) as [number, number, number, number, number, number];
        const [A, B, C, D, E, F] = ctm as [number, number, number, number, number, number];
        ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
      }
      const doOp = line.match(/^\/(\S+) Do$/);
      if (doOp) draws.push({ name: doOp[1]!, m: ctm });
    }
    for (const draw of draws) {
      const ref = xobjects?.get(PDFName.of(draw.name));
      if (!(ref instanceof PDFRef)) continue;
      const stream = pdf.context.lookup(ref) as PDFRawStream;
      if (stream.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      const pixelWidth = Number(stream.dict.lookup(PDFName.of('Width'))?.toString());
      const pixelHeight = Number(stream.dict.lookup(PDFName.of('Height'))?.toString());
      images.push({
        ref: ref.toString(),
        pixelWidth,
        pixelHeight,
        // Unrotated, as pdf-lib draws them here: [width 0 0 height x y].
        x: draw.m[4]!,
        y: draw.m[5]!,
        width: draw.m[0]!,
        height: draw.m[3]!,
        qr: decodeQr(stream, pixelWidth, pixelHeight),
      });
    }
    // pdf-lib writes a line as "/<font> <size> Tf", "1 0 0 1 x y Tm",
    // "<hex> Tj"; the font's resource gives its BaseFont.
    const fontDicts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    const runs: PdfTextRun[] = [];
    let font: PdfTextRun['font'] = 'Helvetica';
    let size = 0;
    let at = { x: 0, y: 0 };
    for (const line of ops.split('\n').map((l) => l.trim())) {
      const tf = line.match(/^\/(\S+) ([\d.]+) Tf$/);
      if (tf) {
        const base = (fontDicts?.lookup(PDFName.of(tf[1]!), PDFDict))?.lookup(PDFName.of('BaseFont'))?.toString();
        if (base !== '/Helvetica' && base !== '/Helvetica-Bold') throw new Error(`unexpected font ${base}`);
        font = base.slice(1) as PdfTextRun['font'];
        size = Number(tf[2]);
      }
      const tm = line.match(/^1 0 0 1 ([-\d.]+) ([-\d.]+) Tm$/);
      if (tm) at = { x: Number(tm[1]), y: Number(tm[2]) };
      const tj = line.match(/^<([0-9A-Fa-f]*)> Tj$/);
      if (tj) runs.push({ text: winAnsi(tj[1]!), font, size, ...at, bottom: 0, top: 0, right: 0 });
    }
    return { images, text: runs.map((r) => r.text), runs };
  });
  const fonts = await measuringFonts();
  for (const run of pages.flatMap((p) => p.runs)) {
    const f = fonts[run.font];
    run.bottom = run.y - (f.heightAtSize(run.size) - f.heightAtSize(run.size, { descender: false }));
    run.top = run.y + f.heightAtSize(run.size, { descender: false });
    run.right = run.x + f.widthOfTextAtSize(run.text, run.size);
  }
  return pages;
};

/** Every image object in the whole document, drawn or not (SMasks excluded). */
export const pdfImageObjectsOf = async (bytes: Buffer | Uint8Array): Promise<{ pixelWidth: number; pixelHeight: number }[]> => {
  const pdf = await PDFDocument.load(bytes);
  const smasks = new Set<string>();
  const images: { ref: string; pixelWidth: number; pixelHeight: number }[] = [];
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const smask = obj.dict.get(PDFName.of('SMask'));
    if (smask) smasks.add(smask.toString());
    images.push({
      ref: ref.toString(),
      pixelWidth: Number(obj.dict.lookup(PDFName.of('Width'))?.toString()),
      pixelHeight: Number(obj.dict.lookup(PDFName.of('Height'))?.toString()),
    });
  }
  return images.filter((i) => !smasks.has(i.ref)).map(({ pixelWidth, pixelHeight }) => ({ pixelWidth, pixelHeight }));
};
