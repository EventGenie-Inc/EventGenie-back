import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { type DeliveryMethod } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  detectContactShape,
  normalizeEmail,
  assertValidEmail,
  normalizePhoneToE164,
  findDuplicateEmail,
  isValidPlusOnesAllowed,
  PLUS_ONES_ALLOWED_MESSAGE,
  type ExistingContact,
  GUEST_EMAIL_REQUIRED_MESSAGE,
} from './guest-validation.util.js';

// Independent, DB-free module: parsing and validation take plain data in
// and return plain data out. No Prisma import anywhere in this file — the
// service layer (guest.service.ts) is the only thing that talks to the
// database, fetching what this module needs (event days, existing
// contacts) up front.

// At most this many data rows per file, refused whole (422) before any row
// is validated or written. 2,000 covers the guest list of a private event
// of any realistic size in one file, and keeps one import (validation and
// a single write transaction) well inside a request's time; a bigger list
// goes in as several files. Was 5,000, an uncoded 400.
export const MAX_IMPORT_ROWS = 2000;
export const GUEST_IMPORT_TOO_MANY_ROWS = 'GUEST_IMPORT_TOO_MANY_ROWS';

// A file named .xlsx or .csv that can't be read as one (422): not a real
// workbook (an .xls or a web page renamed), a damaged one, or a CSV the
// parser refuses. Was a 500 for a workbook exceljs threw on, and an
// uncoded 400 with the parser's own words for a CSV.
export const GUEST_IMPORT_UNREADABLE_FILE = 'GUEST_IMPORT_UNREADABLE_FILE';
export const GUEST_IMPORT_UNREADABLE_FILE_MESSAGE = "We couldn't read this file. Save it as .xlsx or .csv and try again.";

// How far an uploaded workbook may unpack, refused past either as
// unreadable (GUEST_IMPORT_UNREADABLE_FILE). A real 2,000-row guest list
// unpacks to about 0.6 MB and takes about 21 MB of memory to read; 3 MB
// for any one part and 4 MB in all are 5 and 6.5 times that, and
// MAX_IMPORT_ROWS already caps the rows. Measured 2026-10-25: 2,000 rows
// with extra columns, unpacking to 3.9 MB, took about 75 MB to read (0.35 s);
// the rest of the import doesn't grow with columns it never reads.
export const MAX_UNPACKED_WORKBOOK_BYTES = 4 * 1024 * 1024;
export const MAX_UNPACKED_PART_BYTES = 3 * 1024 * 1024;

const unreadableFile = (): HttpError => new HttpError(422, GUEST_IMPORT_UNREADABLE_FILE_MESSAGE, GUEST_IMPORT_UNREADABLE_FILE);

export interface ParsedImportRow {
  rowNumber: number; // the actual row the user sees in Excel (header = row 1)
  firstNameRaw: string;
  surnameRaw: string;
  contactRaw: string;
  dayRaw: string;
  plusOnesAllowedRaw: string;
}

interface RawRow {
  rowNumber: number;
  cells: string[];
}

const cellValueToString = (value: unknown): string => {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return obj['text'];
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as { text: string }[]).map((rt) => rt.text).join('');
    }
    if (obj['result'] !== undefined) return String(obj['result']);
  }
  return String(value).trim();
};

// Relationships to a sheet's comments and notes: legacy comments (what
// Excel calls notes), the VML drawing that positions them, and Excel 365's
// threaded comments.
const COMMENT_RELATIONSHIP =
  /<(?:\w+:)?Relationship\b[^>]*?\bType\s*=\s*["'][^"']*\/(?:comments|vmlDrawing|threadedComment)["'][^>]*?\/>/g;
const COMMENT_PART = /^xl\/(?:comments[^/]*\.xml|comments\/.*|threadedComments\/.*|persons\/.*|drawings\/[^/]*\.vml)$/i;

// The workbook without its comments and notes, which the import never
// reads. exceljs (4.4.0) finds a sheet's comments by the exact path Excel
// itself writes (Target="../comments1.xml", part xl/commentsN.xml); any
// other valid layout (an absolute Target, a comments part in a subfolder,
// a VML drawing by another name, as other spreadsheet apps write) is a
// TypeError, "Cannot read properties of undefined (reading 'comments')",
// thrown from load(). Dropping these parts before load() keeps the same
// reader, and the same cell values, for every file that already imported.
//
// Unpacked part by part, counting the bytes as they inflate, never trusting
// the sizes the file declares (a crafted file can lie about them), and
// refused as unreadable past either cap: a few hundred KB uploaded can
// unpack to gigabytes, and exceljs holds the whole workbook in memory.
// loadAsync only reads the file's index, so nothing is unpacked before the
// count starts, and the comment parts are never unpacked at all.
const withoutComments = async (buffer: Buffer): Promise<Buffer> => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw unreadableFile();
  }
  const out = new JSZip();
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || COMMENT_PART.test(entry.name)) continue;
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      let refused = false;
      const stream = entry.nodeStream('nodebuffer');
      stream
        .on('data', (chunk: Buffer) => {
          if (refused) return;
          size += chunk.length;
          total += chunk.length;
          if (size > MAX_UNPACKED_PART_BYTES || total > MAX_UNPACKED_WORKBOOK_BYTES) {
            refused = true;
            stream.pause();
            reject(unreadableFile());
            return;
          }
          chunks.push(chunk);
        })
        .on('error', () => reject(unreadableFile()))
        .on('end', () => resolve());
    });
    const content = Buffer.concat(chunks);
    out.file(
      entry.name,
      /^xl\/worksheets\/_rels\/[^/]+\.rels$/i.test(entry.name)
        ? content.toString('utf8').replace(COMMENT_RELATIONSHIP, '')
        : content
    );
  }
  // STORE: exceljs inflates it straight back, so compressing is wasted work.
  return out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
};

const parseXlsxRows = async (buffer: Buffer): Promise<RawRow[]> => {
  const workbook = new ExcelJS.Workbook();
  const readable = await withoutComments(buffer);
  try {
    // exceljs's bundled Buffer typing doesn't line up with this repo's
    // @types/node version (a generic-parameter mismatch, not a real type
    // hazard — buffer is a genuine Node Buffer at runtime either way).
    await workbook.xlsx.load(readable as never);
  } catch {
    // Anything else exceljs can't take (a damaged or unusual workbook):
    // the organiser can re-save it, which a 500 never told them.
    throw unreadableFile();
  }
  // A real workbook always has a sheet: none is a zip that isn't one.
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw unreadableFile();

  const rows: RawRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [1, 2, 3, 4, 5].map((col) => cellValueToString(row.getCell(col).value));
    rows.push({ rowNumber: row.number, cells });
  });
  return rows;
};

const parseCsvRows = (buffer: Buffer): RawRow[] => {
  let records: string[][];
  try {
    records = parseCsvSync(buffer, { relax_column_count: true, bom: true }) as string[][];
  } catch {
    throw unreadableFile();
  }
  return records.map((cells, idx) => ({
    rowNumber: idx + 1,
    cells: [0, 1, 2, 3, 4].map((i) => (cells[i] ?? '').toString().trim()),
  }));
};

export const parseImportFile = async (
  buffer: Buffer,
  originalFilename: string,
  mimeType: string
): Promise<ParsedImportRow[]> => {
  const ext = (originalFilename.split('.').pop() ?? '').toLowerCase();
  const isXlsx = ext === 'xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const isCsv = ext === 'csv' || mimeType === 'text/csv';

  if (!isXlsx && !isCsv) {
    throw new HttpError(400, `Unsupported file type '${ext || mimeType}'. Upload an .xlsx or .csv file.`);
  }

  const rawRows = isXlsx ? await parseXlsxRows(buffer) : parseCsvRows(buffer);

  const dataRows = rawRows
    .filter((r) => r.rowNumber > 1) // row 1 is always the header
    .map((r) => ({
      rowNumber: r.rowNumber,
      firstNameRaw: r.cells[0] ?? '',
      surnameRaw: r.cells[1] ?? '',
      contactRaw: r.cells[2] ?? '',
      dayRaw: r.cells[3] ?? '',
      plusOnesAllowedRaw: r.cells[4] ?? '',
    }))
    .filter((r) => r.firstNameRaw || r.surnameRaw || r.contactRaw || r.dayRaw || r.plusOnesAllowedRaw); // drop fully-blank rows

  if (dataRows.length === 0) {
    throw new HttpError(400, 'The uploaded file has no data rows');
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new HttpError(
      422,
      `This file has ${dataRows.length.toLocaleString('en-US')} guest rows, but one import can take at most ` +
        `${MAX_IMPORT_ROWS.toLocaleString('en-US')}, so nothing was imported. Split the list into smaller files.`,
      GUEST_IMPORT_TOO_MANY_ROWS
    );
  }

  return dataRows;
};

export interface EventDayOption {
  id: string;
  label: string;
}

export interface ValidatedGuestRow {
  rowNumber: number;
  firstName: string | null;
  surname: string | null;
  email: string | null;
  phoneNumber: string | null;
  deliveryMethod: DeliveryMethod;
  eventDayIds: string[];
  plusOnesAllowed: number;
}

export interface ImportRowFailure {
  row: number;
  contact: string;
  reason: string;
}

export interface ImportEngineResult {
  totalRows: number;
  validRows: ValidatedGuestRow[];
  failures: ImportRowFailure[];
}

export const validateImportRows = (
  rows: ParsedImportRow[],
  eventDays: EventDayOption[],
  existingContacts: ExistingContact[],
  // Set while the sms feature is off: a phone-only row is refused with
  // GUEST_EMAIL_REQUIRED_MESSAGE, and the rest of the file imports.
  options: { requireEmail?: boolean } = {}
): ImportEngineResult => {
  const failures: ImportRowFailure[] = [];
  const validRows: ValidatedGuestRow[] = [];
  // Tracks contacts already accepted from earlier rows in this same file —
  // a DB query can't see sibling rows in an uncommitted batch, so this is
  // necessarily import-specific, but it calls the exact same shared
  // findDuplicateEmail used for the DB check and for manual create.
  const seenInFile: ExistingContact[] = [];
  // A phone repeated within this one file is a duplicated row (a list
  // pasted twice), flagged like a repeated email. Only within the file:
  // guests may share a phone, so a phone an existing guest already has is
  // never a duplicate (guest-validation.util.ts).
  const phonesSeenInFile = new Map<string, number>();

  const dayLabelMap = new Map(eventDays.map((d) => [d.label.trim().toLowerCase(), d]));

  for (const row of rows) {
    const contactRaw = row.contactRaw.trim();
    const fail = (reason: string): void => {
      failures.push({ row: row.rowNumber, contact: contactRaw || '(blank)', reason });
    };

    if (!contactRaw) {
      fail('No contact provided');
      continue;
    }

    const shape = detectContactShape(contactRaw);
    let email: string | null = null;
    let phoneNumber: string | null = null;

    try {
      if (shape === 'email') {
        email = normalizeEmail(contactRaw);
        assertValidEmail(email);
      } else if (shape === 'phone') {
        phoneNumber = normalizePhoneToE164(contactRaw);
      } else {
        fail(`'${contactRaw}' does not look like a valid email or phone number`);
        continue;
      }
    } catch (err) {
      fail((err as Error).message);
      continue;
    }

    if (options.requireEmail && !email) {
      fail(GUEST_EMAIL_REQUIRED_MESSAGE);
      continue;
    }

    let eventDayId: string;
    const dayRaw = row.dayRaw.trim();
    if (!dayRaw) {
      if (eventDays.length === 1) {
        eventDayId = eventDays[0]!.id;
      } else {
        fail(`Day is required for this event (choose one of: ${eventDays.map((d) => d.label).join(', ')})`);
        continue;
      }
    } else {
      const matched = dayLabelMap.get(dayRaw.toLowerCase());
      if (!matched) {
        fail(`Day '${dayRaw}' is not a valid day for this event. Valid days are: ${eventDays.map((d) => d.label).join(', ')}`);
        continue;
      }
      eventDayId = matched.id;
    }

    const plusOnesAllowedRaw = row.plusOnesAllowedRaw.trim();
    let plusOnesAllowed = 0;
    if (plusOnesAllowedRaw) {
      plusOnesAllowed = /^\d+$/.test(plusOnesAllowedRaw) ? Number.parseInt(plusOnesAllowedRaw, 10) : Number.NaN;
      if (!isValidPlusOnesAllowed(plusOnesAllowed)) {
        fail(`'${plusOnesAllowedRaw}': ${PLUS_ONES_ALLOWED_MESSAGE}`);
        continue;
      }
    }

    // By email only: guests may share a phone (guest-validation.util.ts).
    const dbDuplicate = findDuplicateEmail(existingContacts, email);
    if (dbDuplicate) {
      fail(`Duplicate contact '${contactRaw}': another guest on this event already has it.`);
      continue;
    }

    const fileDuplicate = findDuplicateEmail(seenInFile, email);
    const firstPhoneRow = phoneNumber ? phonesSeenInFile.get(phoneNumber) : undefined;
    if (fileDuplicate || firstPhoneRow !== undefined) {
      const firstRow = firstPhoneRow ?? /^row-(\d+)$/.exec(fileDuplicate!.guestId)?.[1] ?? '?';
      fail(`Duplicate contact '${contactRaw}': it's also on row ${firstRow} of this file.`);
      continue;
    }

    validRows.push({
      rowNumber: row.rowNumber,
      firstName: row.firstNameRaw.trim() || null,
      surname: row.surnameRaw.trim() || null,
      email,
      phoneNumber,
      deliveryMethod: email ? 'EMAIL' : 'SMS',
      eventDayIds: [eventDayId],
      plusOnesAllowed,
    });
    seenInFile.push({ guestId: `row-${row.rowNumber}`, email });
    if (phoneNumber) phonesSeenInFile.set(phoneNumber, row.rowNumber);
  }

  return { totalRows: rows.length, validRows, failures };
};
