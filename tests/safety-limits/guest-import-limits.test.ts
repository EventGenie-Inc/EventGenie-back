import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';

// ─────────────────────────────────────────
//  SAFETY LIMITS — guest import
//
//  At most 2,000 rows per file, refused whole before any row is validated
//  or written: 422 GUEST_IMPORT_TOO_MANY_ROWS. The upload's own size
//  refusal (multer, 5 MB) is 413 GUEST_IMPORT_FILE_TOO_LARGE with a
//  readable message, not an uncoded 413.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let eventId: string;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventId = (await createEventWithDay(tenant.id, organiser.id)).event.id;
}, 60000);

afterAll(async () => {
  vi.restoreAllMocks();
  await deleteTenantsDeep(tenantIds.splice(0));
}, 120000);

const csvWithRows = (count: number) =>
  Buffer.from(
    'First Name,Surname,Email or Phone,Day,Plus-ones\n' +
      Array.from({ length: count }, (_, i) => `Guest,${i},imp-${i}-${randomUUID()}@test.invalid,Day 1,0`).join('\n') +
      '\n'
  );

const importFile = (buffer: Buffer, filename = 'guests.csv') =>
  request(app)
    .post(`/api/events/${eventId}/guests/import`)
    .set(headersFor(organiser))
    .attach('file', buffer, { filename, contentType: 'text/csv' });

describe('guest import: rows per file', () => {
  it('2,001 rows is 422 GUEST_IMPORT_TOO_MANY_ROWS, and no row is checked or written', async () => {
    installFirebaseMock();
    const write = vi.spyOn(guestRepository, 'bulkCreateWithInvites');
    const contacts = vi.spyOn(guestRepository, 'findContactsForEvent');

    const res = await importFile(csvWithRows(2001));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message:
        'This file has 2,001 guest rows, but one import can take at most 2,000, so nothing was imported. ' +
        'Split the list into smaller files.',
      code: 'GUEST_IMPORT_TOO_MANY_ROWS',
    });
    expect(contacts).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await prisma.guest.count({ where: { eventId } })).toBe(0);
  }, 60000);

  it('exactly 2,000 rows imports', async () => {
    installFirebaseMock();
    vi.restoreAllMocks();
    const res = await importFile(csvWithRows(2000));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalRows: 2000, created: 2000, failed: 0 });
  }, 120000);
});

describe('guest import: file size', () => {
  it('a file over 5 MB is 413 GUEST_IMPORT_FILE_TOO_LARGE with a readable message, and nothing is imported', async () => {
    installFirebaseMock();
    const before = await prisma.guest.count({ where: { eventId } });
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
    const res = await importFile(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      status: 'error',
      message:
        'This file is larger than 5 MB, so nothing was imported. ' +
        'Remove empty rows and extra sheets, or split the list into smaller files.',
      code: 'GUEST_IMPORT_FILE_TOO_LARGE',
    });
    expect(await prisma.guest.count({ where: { eventId } })).toBe(before);
  }, 60000);
});
