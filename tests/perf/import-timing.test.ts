import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import request from 'supertest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import app from '../../src/app.js';
import { MAX_UNPACKED_WORKBOOK_BYTES } from '../../src/modules/guest/guest-import.engine.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  HOW LONG A GUEST IMPORT TAKES, AND HOW MUCH MEMORY — a measurement, not
//  a guarantee. Opt-in, so the ordinary suite never waits on it:
//
//    MEASURE_IMPORT_TIMING=1 MEASURE_IMPORT_TIMING_OUT=timings.txt \
//      npx vitest run tests/perf/import-timing.test.ts
//
//  300 and 2,000 guests, as .xlsx (a note on the Contact header, in the
//  layout exceljs used to crash on: absolute comment Targets) and as .csv,
//  and 2,000 guests with extra columns unpacking to just under
//  MAX_UNPACKED_WORKBOOK_BYTES, the heaviest workbook the import still
//  reads; each over HTTP into its own event on the test database. Peak memory is
//  the process's resident set, sampled every 5 ms during the request, less
//  what it was just before: the vitest process is the server here, so the
//  absolute figure includes vitest itself. Staging runs on 512 MB.
// ─────────────────────────────────────────

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

let tenantId: string;
let organiser: Actor;
const results: string[] = [];

const guestRow = (i: number) => [`First${i}`, `Surname${i}`, `import.timing.${i}@test.invalid`, 'Day 1', String(i % 3)];

// `extra` text columns after the five the import reads, which it ignores
// but exceljs still holds in memory: 24 of them on 2,000 rows unpack to
// just under MAX_UNPACKED_WORKBOOK_BYTES.
const NEAR_CAP_EXTRA_COLUMNS = 24;

const xlsxWith = async (count: number, extra = 0): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Guests');
  const extras = (row: string | number) => Array.from({ length: extra }, (_, c) => (row === 'header' ? `Note ${c + 1}` : `Note ${c + 1} for guest ${row}`));
  sheet.addRow(['First Name', 'Surname', 'Contact', 'Day', 'Plus-Ones Allowed', ...extras('header')]);
  for (let i = 0; i < count; i++) sheet.addRow([...guestRow(i), ...extras(i)]);
  sheet.getCell('C1').note = 'One email address per guest.';
  const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
  const rels = 'xl/worksheets/_rels/sheet1.xml.rels';
  zip.file(rels, (await zip.file(rels)!.async('string')).replace(/Target="\.\.\//g, 'Target="/xl/'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

const csvWith = (count: number): Buffer =>
  Buffer.from(['First Name,Surname,Contact,Day,Plus-Ones Allowed', ...Array.from({ length: count }, (_, i) => guestRow(i).join(','))].join('\n') + '\n');

describe.skipIf(!process.env['MEASURE_IMPORT_TIMING'])('guest import: time and peak memory', () => {
  beforeAll(async () => {
    const tenant = await createTenant();
    tenantId = tenant.id;
    organiser = await createActor('TENANT_ADMIN', tenant.id);
  }, 60000);

  afterAll(async () => {
    await deleteTenantsDeep([tenantId]);
    // Vitest swallows a passing test's console output, so the timings also
    // go to the file MEASURE_IMPORT_TIMING_OUT names, when set.
    const report = results.join('\n');
    console.log(`\n${report}`);
    const out = process.env['MEASURE_IMPORT_TIMING_OUT'];
    if (out) writeFileSync(out, `${report}\n`);
  }, 300000);

  const cases: [count: number, kind: 'xlsx' | 'csv', nearCap: boolean][] = [
    [300, 'xlsx', false], [300, 'csv', false], [2000, 'xlsx', false], [2000, 'csv', false], [2000, 'xlsx', true],
  ];
  for (const [count, kind, nearCap] of cases) {
    it(`${count.toLocaleString('en-US')} rows, .${kind}${nearCap ? ', just under the unpack cap' : ''}`, async () => {
      installFirebaseMock();
      const eventId = (await createEventWithDay(tenantId, organiser.id)).event.id;
      const file = kind === 'xlsx' ? await xlsxWith(count, nearCap ? NEAR_CAP_EXTRA_COLUMNS : 0) : csvWith(count);
      let unpacked = 0;
      if (kind === 'xlsx') {
        const zip = await JSZip.loadAsync(file);
        for (const entry of Object.values(zip.files)) if (!entry.dir) unpacked += (await entry.async('uint8array')).length;
      }
      if (nearCap) {
        expect(unpacked).toBeLessThan(MAX_UNPACKED_WORKBOOK_BYTES);
        expect(unpacked).toBeGreaterThan(MAX_UNPACKED_WORKBOOK_BYTES * 0.95);
      }

      global.gc?.();
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
      const start = performance.now();
      const res = await request(app)
        .post(`/api/events/${eventId}/guests/import`)
        .set(headersFor(organiser))
        .attach('file', file, { filename: `guests.${kind}`, contentType: kind === 'xlsx' ? XLSX_TYPE : 'text/csv' });
      const ms = Math.round(performance.now() - start);
      clearInterval(sampler);
      peak = Math.max(peak, process.memoryUsage().rss);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ totalRows: count, created: count, failed: 0 });
      expect(await prisma.guest.count({ where: { eventId } })).toBe(count);
      results.push(
        `${String(count).padStart(5)} rows .${kind.padEnd(4)} ${(file.length / 1024).toFixed(0).padStart(4)} KB  ` +
          `${kind === 'xlsx' ? `unpacked ${mb(unpacked)} MB  ` : ''}` +
          `${String(ms).padStart(6)} ms  rss ${mb(before)} -> peak ${mb(peak)} MB (+${mb(peak - before)})`
      );
    }, 300000);
  }
});
