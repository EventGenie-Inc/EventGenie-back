import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import app from '../../src/app.js';
import { MAX_UNPACKED_PART_BYTES, MAX_UNPACKED_WORKBOOK_BYTES } from '../../src/modules/guest/guest-import.engine.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';

// ─────────────────────────────────────────
//  GUEST IMPORT — workbooks with comments, and files we can't read
//
//  exceljs 4.4.0 finds a sheet's comments (notes) only at the path Excel
//  itself writes (Target="../comments1.xml"). A valid workbook laying them
//  out any other way (absolute Target, a comments part in a subfolder, a
//  VML drawing by another name) made load() throw "Cannot read properties
//  of undefined (reading 'comments')": a 500 on POST .../guests/import.
//  The engine now drops comments and notes before loading. Any file it
//  still can't read is 422 GUEST_IMPORT_UNREADABLE_FILE, never a 500, as is
//  a workbook that unpacks past MAX_UNPACKED_PART_BYTES (one part) or
//  MAX_UNPACKED_WORKBOOK_BYTES (all of it).
//
//  fixtures/guest-list-with-note.xlsx: written by desktop Excel (header,
//  three guests, a note on C1), then its sheet's comment and VML
//  relationships given absolute Targets ("/xl/comments1.xml"), the layout
//  that crashed. Excel opens it with the note intact.
// ─────────────────────────────────────────

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/guest-list-with-note.xlsx', import.meta.url)));
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UNREADABLE = {
  status: 'error',
  message: "We couldn't read this file. Save it as .xlsx or .csv and try again.",
  code: 'GUEST_IMPORT_UNREADABLE_FILE',
};

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

afterAll(async () => {
  vi.restoreAllMocks();
  await deleteTenantsDeep(tenantIds.splice(0));
}, 120000);

const newEvent = async () => (await createEventWithDay(tenantId, organiser.id)).event.id;

const importFile = (eventId: string, buffer: Buffer, filename: string, contentType = XLSX_TYPE) =>
  request(app)
    .post(`/api/events/${eventId}/guests/import`)
    .set(headersFor(organiser))
    .attach('file', buffer, { filename, contentType });

// The fixture with its sheet relationships and parts rewritten by `edit`.
const variantOf = async (edit: (zip: JSZip, rels: string) => Promise<string>): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(FIXTURE);
  const path = 'xl/worksheets/_rels/sheet1.xml.rels';
  zip.file(path, await edit(zip, await zip.file(path)!.async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
};

const move = async (zip: JSZip, from: string, to: string) => {
  zip.file(to, await zip.file(from)!.async('nodebuffer'));
  zip.remove(from);
};

describe('guest import: workbooks with comments or notes', () => {
  it('the real workbook with a note that crashed (500) imports every guest', async () => {
    installFirebaseMock();
    const eventId = await newEvent();
    const res = await importFile(eventId, FIXTURE, 'guests.xlsx');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 3, created: 3, failed: 0 });
    const emails = (await prisma.guest.findMany({ where: { eventId }, select: { email: true } })).map((g) => g.email).sort();
    expect(emails).toEqual(['ayesha.patel@example.com', 'pieter.vanwyk@example.com', 'thandi.nkosi@example.com']);
  }, 60000);

  it('the other layouts that crashed import too: comments in a subfolder, a VML drawing by another name', async () => {
    installFirebaseMock();
    const subfolder = await variantOf(async (zip, rels) => {
      await move(zip, 'xl/comments1.xml', 'xl/comments/comment1.xml');
      return rels.replace('/xl/comments1.xml', '/xl/comments/comment1.xml');
    });
    const vmlRenamed = await variantOf(async (zip, rels) => {
      await move(zip, 'xl/drawings/vmlDrawing1.vml', 'xl/drawings/notes1.vml');
      return rels.replace('/xl/drawings/vmlDrawing1.vml', '/xl/drawings/notes1.vml');
    });
    for (const buffer of [subfolder, vmlRenamed]) {
      const res = await importFile(await newEvent(), buffer, 'guests.xlsx');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ totalRows: 3, created: 3, failed: 0 });
    }
  }, 90000);

  it("Excel's own layout (relative Targets) still imports: the control", async () => {
    installFirebaseMock();
    const excelLayout = await variantOf(async (_zip, rels) =>
      rels.replace('/xl/comments1.xml', '../comments1.xml').replace('/xl/drawings/vmlDrawing1.vml', '../drawings/vmlDrawing1.vml'));
    const res = await importFile(await newEvent(), excelLayout, 'guests.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 3, created: 3, failed: 0 });
  }, 60000);
});

describe('guest import: a file we cannot read', () => {
  it('is 422 GUEST_IMPORT_UNREADABLE_FILE, never a 500, and nothing is checked or written', async () => {
    installFirebaseMock();
    const eventId = await newEvent();
    const contacts = vi.spyOn(guestRepository, 'findContactsForEvent');
    const write = vi.spyOn(guestRepository, 'bulkCreateWithInvites');

    const cases: [string, Buffer, string, string][] = [
      ['not a workbook (an .xls or a web page renamed)', Buffer.from('<html>not a spreadsheet</html>'), 'guests.xlsx', XLSX_TYPE],
      ['a damaged workbook (cut short)', FIXTURE.subarray(0, 3000), 'guests.xlsx', XLSX_TYPE],
      ['a workbook with no sheets inside', await new JSZip().file('hello.txt', 'hi').generateAsync({ type: 'nodebuffer' }), 'guests.xlsx', XLSX_TYPE],
      ['a CSV the parser refuses (unclosed quote)', Buffer.from('First Name,Surname,Contact\n"Thandi,Nkosi,t@example.com\n'), 'guests.csv', 'text/csv'],
    ];
    for (const [label, buffer, filename, type] of cases) {
      const res = await importFile(eventId, buffer, filename, type);
      expect(res.status, label).toBe(422);
      expect(res.body, label).toEqual(UNREADABLE);
    }
    expect(contacts).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await prisma.guest.count({ where: { eventId } })).toBe(0);
    vi.restoreAllMocks();
  }, 90000);
});

// A workbook that unpacks far past what it uploads as: the fixture (a real,
// readable workbook) plus zero-filled parts, which deflate to almost
// nothing. Without the caps exceljs takes them (as media) and the guests
// import.
const withFiller = async (partSizes: number[]): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(FIXTURE);
  partSizes.forEach((size, i) => zip.file(`xl/media/filler${i}.bin`, Buffer.alloc(size)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
};

describe('guest import: how far a workbook may unpack', () => {
  it('one part past its cap, or all parts past the total, is 422 GUEST_IMPORT_UNREADABLE_FILE, and nothing is written', async () => {
    installFirebaseMock();
    const eventId = await newEvent();
    const write = vi.spyOn(guestRepository, 'bulkCreateWithInvites');

    // Just past one cap and inside the other, so each case can only be
    // refused by the cap it names: one part just past its cap, the whole
    // still under the total; two parts each under the part cap, together
    // just past the total.
    const justPast = 64 * 1024;
    expect(MAX_UNPACKED_PART_BYTES + justPast).toBeLessThan(MAX_UNPACKED_WORKBOOK_BYTES - 100 * 1024);
    const half = MAX_UNPACKED_WORKBOOK_BYTES / 2 + justPast;
    expect(half).toBeLessThan(MAX_UNPACKED_PART_BYTES);
    const cases: [string, Buffer][] = [
      ['one part past its cap', await withFiller([MAX_UNPACKED_PART_BYTES + justPast])],
      ['parts together past the total', await withFiller([half, half])],
    ];
    for (const [label, buffer] of cases) {
      // Small to upload: the point is how far it unpacks.
      expect(buffer.length, label).toBeLessThan(200 * 1024);
      const res = await importFile(eventId, buffer, 'guests.xlsx');
      expect(res.status, label).toBe(422);
      expect(res.body, label).toEqual(UNREADABLE);
    }
    expect(write).not.toHaveBeenCalled();
    expect(await prisma.guest.count({ where: { eventId } })).toBe(0);
    vi.restoreAllMocks();
  }, 120000);

  it('a real 2,000-row guest list unpacks to a small fraction of the caps and imports every guest', async () => {
    installFirebaseMock();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Guests');
    sheet.addRow(['First Name', 'Surname', 'Contact', 'Day', 'Plus-Ones Allowed']);
    for (let i = 0; i < 2000; i++) sheet.addRow([`Firstname${i}`, `Surname${i}`, `a.long.guest.address.${i}@example-company.co.za`, 'Day 1', String(i % 3)]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const zip = await JSZip.loadAsync(buffer);
    let unpacked = 0;
    for (const entry of Object.values(zip.files)) if (!entry.dir) unpacked += (await entry.async('uint8array')).length;
    expect(unpacked).toBeLessThan(MAX_UNPACKED_PART_BYTES / 3);

    const eventId = await newEvent();
    const res = await importFile(eventId, buffer, 'guests.xlsx');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 2000, created: 2000, failed: 0 });
    expect(await prisma.guest.count({ where: { eventId } })).toBe(2000);
  }, 180000);
});

describe('guest import: our own template', () => {
  it('has no cell comments or notes; its notes are on an Instructions sheet after Guests, and it imports as-is', async () => {
    installFirebaseMock();
    const eventId = await newEvent();
    const { buffer } = await guestService.getImportTemplate(eventId, 'TENANT_ADMIN', tenantId);

    const zip = await JSZip.loadAsync(buffer);
    const parts = Object.keys(zip.files);
    expect(parts.filter((p) => /comments|threadedComments|\.vml$/i.test(p))).toEqual([]);
    const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
    const sheetNames = [...workbookXml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
    expect(sheetNames).toEqual(['Guests', 'Instructions']);

    const res = await importFile(eventId, buffer, 'template.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 3, created: 3, failed: 0 });
  }, 60000);
});
