import JSZip from 'jszip';
import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  WHAT A GUEST'S FILE REALLY IS
//
//  Decided from the bytes, never from the name or the browser's stated
//  type, either of which anyone can set. Allowed: PDF, JPG, PNG and XLSX.
//  The name's extension must also be one of the detected type's own
//  (a PNG called .pdf is refused), so the organiser's download is what its
//  name says. Everything else is DOCUMENT_TYPE_NOT_ALLOWED, including a
//  macro workbook (.xlsm, or a workbook carrying VBA, macro sheets, ActiveX
//  or embedded objects under an .xlsx name), an Excel template, a legacy
//  .xls, a CSV or any other text file (a CSV opened in a spreadsheet can
//  run formulas on the organiser's machine) and any executable renamed to
//  an allowed name.
//
//  DB-free and Cloudinary-free; the service decides what to do with it.
// ─────────────────────────────────────────

export type DocumentFormat = 'pdf' | 'jpg' | 'png' | 'xlsx';

export const DOCUMENT_CONTENT_TYPES: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EXTENSIONS: Record<DocumentFormat, readonly string[]> = {
  pdf: ['pdf'],
  jpg: ['jpg', 'jpeg'],
  png: ['png'],
  xlsx: ['xlsx'],
};

export const DOCUMENT_TYPE_NOT_ALLOWED = 'DOCUMENT_TYPE_NOT_ALLOWED';
export const DOCUMENT_TYPE_NOT_ALLOWED_MESSAGE = "This file type can't be uploaded. Use a PDF, JPG, PNG or XLSX file.";

const notAllowed = (): HttpError => new HttpError(422, DOCUMENT_TYPE_NOT_ALLOWED_MESSAGE, DOCUMENT_TYPE_NOT_ALLOWED);

const startsWith = (buffer: Buffer, bytes: readonly number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const; // "PK\3\4"

// The one main part an .xlsx has, and what makes a workbook something else.
const XLSX_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const FORBIDDEN_CONTENT_TYPE = /macroEnabled|vbaProject|template\.main|addin|ms-office\.activeX|oleObject/i;
const FORBIDDEN_PART = /(^|\/)(vbaProject[^/]*\.bin|vbaData\.xml)$|^xl\/(macrosheets|activeX|embeddings|dialogsheets)\//i;
// [Content_Types].xml is a few KB; read at most this much of it, counting
// as it inflates (never trusting the size the file declares).
const MAX_CONTENT_TYPES_BYTES = 256 * 1024;

const readBounded = async (entry: JSZip.JSZipObject, limit: number): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const stream = entry.nodeStream('nodebuffer');
    stream
      .on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > limit) {
          done = true;
          resolve(null);
          return;
        }
        chunks.push(chunk);
      })
      .on('error', () => {
        if (!done) { done = true; resolve(null); }
      })
      .on('end', () => {
        if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); }
      });
  });

// A real .xlsx: a zip whose content types name the ordinary workbook part,
// and nothing that runs code. Only the index and [Content_Types].xml are
// read; no other part is ever unpacked.
const isPlainWorkbook = async (buffer: Buffer): Promise<boolean> => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return false;
  }
  const names = Object.keys(zip.files);
  if (names.some((name) => FORBIDDEN_PART.test(name))) return false;
  const contentTypes = zip.file('[Content_Types].xml');
  if (!contentTypes || !zip.file('xl/workbook.xml')) return false;
  const xml = await readBounded(contentTypes, MAX_CONTENT_TYPES_BYTES);
  if (xml === null) return false;
  return xml.includes(XLSX_MAIN) && !FORBIDDEN_CONTENT_TYPE.test(xml);
};

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
};

// The detected format, or DOCUMENT_TYPE_NOT_ALLOWED. Checked from the
// bytes first; the name's extension must then be that format's own.
export const detectDocumentFormat = async (buffer: Buffer, fileName: string): Promise<DocumentFormat> => {
  let format: DocumentFormat | null = null;
  if (startsWith(buffer, PDF_SIGNATURE)) format = 'pdf';
  else if (startsWith(buffer, PNG_SIGNATURE)) format = 'png';
  else if (startsWith(buffer, JPG_SIGNATURE)) format = 'jpg';
  else if (startsWith(buffer, ZIP_SIGNATURE)) format = (await isPlainWorkbook(buffer)) ? 'xlsx' : null;

  if (!format || !EXTENSIONS[format].includes(extensionOf(fileName))) throw notAllowed();
  return format;
};

// The name kept for the organiser: the file's own name without any path,
// control characters or bidi overrides, at most 200 characters, never
// blank. Stored, shown to the organiser, never logged.
export const cleanFileName = (raw: string, format: DocumentFormat): string => {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001F\u007F‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 200);
  return cleaned || `document.${format}`;
};

// The last segment of the Cloudinary public id, which Cloudinary names the
// download after: the name's stem with accents dropped and every run of
// other characters one hyphen, at most 80 characters, then the format's
// extension. "Proof of payment (1).PDF" downloads as "Proof-of-payment-1.pdf".
export const safeDownloadName = (fileName: string, format: DocumentFormat): string => {
  const dot = fileName.lastIndexOf('.');
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${stem || 'document'}.${format}`;
};
