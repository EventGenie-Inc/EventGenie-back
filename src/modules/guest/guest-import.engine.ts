import ExcelJS from 'exceljs';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { type DeliveryMethod } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  detectContactShape,
  normalizeEmail,
  assertValidEmail,
  normalizePhoneToE164,
  findDuplicateContact,
  type ExistingContact,
} from './guest-validation.util.js';

// Independent, DB-free module: parsing and validation take plain data in
// and return plain data out. No Prisma import anywhere in this file — the
// service layer (guest.service.ts) is the only thing that talks to the
// database, fetching what this module needs (event days, existing
// contacts) up front.

const MAX_IMPORT_ROWS = 5000;

export interface ParsedImportRow {
  rowNumber: number; // the actual row the user sees in Excel (header = row 1)
  firstNameRaw: string;
  surnameRaw: string;
  contactRaw: string;
  dayRaw: string;
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

const parseXlsxRows = async (buffer: Buffer): Promise<RawRow[]> => {
  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled Buffer typing doesn't line up with this repo's
  // @types/node version (a generic-parameter mismatch, not a real type
  // hazard — buffer is a genuine Node Buffer at runtime either way).
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const rows: RawRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [1, 2, 3, 4].map((col) => cellValueToString(row.getCell(col).value));
    rows.push({ rowNumber: row.number, cells });
  });
  return rows;
};

const parseCsvRows = (buffer: Buffer): RawRow[] => {
  let records: string[][];
  try {
    records = parseCsvSync(buffer, { relax_column_count: true, bom: true }) as string[][];
  } catch (err) {
    throw new HttpError(400, `Could not parse CSV file: ${(err as Error).message}`);
  }
  return records.map((cells, idx) => ({
    rowNumber: idx + 1,
    cells: [0, 1, 2, 3].map((i) => (cells[i] ?? '').toString().trim()),
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
    throw new HttpError(400, `Unsupported file type '${ext || mimeType}' — only .xlsx and .csv files are supported`);
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
    }))
    .filter((r) => r.firstNameRaw || r.surnameRaw || r.contactRaw || r.dayRaw); // drop fully-blank rows

  if (dataRows.length === 0) {
    throw new HttpError(400, 'The uploaded file has no data rows');
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new HttpError(
      400,
      `This file has ${dataRows.length} data rows, exceeding the maximum of ${MAX_IMPORT_ROWS} rows per import — split it into smaller batches`
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
  existingContacts: ExistingContact[]
): ImportEngineResult => {
  const failures: ImportRowFailure[] = [];
  const validRows: ValidatedGuestRow[] = [];
  // Tracks contacts already accepted from earlier rows in this same file —
  // a DB query can't see sibling rows in an uncommitted batch, so this is
  // necessarily import-specific, but it calls the exact same shared
  // findDuplicateContact used for the DB check and for manual create.
  const seenInFile: ExistingContact[] = [];

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

    const dbDuplicate = findDuplicateContact(existingContacts, { email, phoneNumber });
    if (dbDuplicate) {
      fail(`Duplicate contact '${contactRaw}' — already exists for this event`);
      continue;
    }

    const fileDuplicate = findDuplicateContact(seenInFile, { email, phoneNumber });
    if (fileDuplicate) {
      const firstRow = /^row-(\d+)$/.exec(fileDuplicate.guestId)?.[1] ?? '?';
      fail(`Duplicate contact '${contactRaw}' — appears more than once in this file (first seen on row ${firstRow})`);
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
    });
    seenInFile.push({ guestId: `row-${row.rowNumber}`, email, phoneNumber });
  }

  return { totalRows: rows.length, validRows, failures };
};
