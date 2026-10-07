import { describe, it, expect, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { randomUUID } from 'crypto';
import { eventService } from '../../src/modules/event/event.service.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { TICKETING_UNAVAILABLE_MESSAGE } from '../../src/modules/ticket/ticketing-availability.util.js';
import { PUBLIC_EVENTS_UNAVAILABLE_MESSAGE } from '../../src/modules/event/public-events-availability.util.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  deleteTestEvent,
  createTestEventDay,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  LAUNCH MODE gaps
//  1. With ticketing / publicEvents off, only a CHANGE to paid / public is
//     refused. An older event already saved as paid or public stays
//     editable, including a full-form save that re-sends the stored value,
//     and is not then refused by a plan check or a payout-account check.
//  2. With sms off, the import template asks for an email for every guest
//     and its examples are emails, so a template used as-is imports cleanly.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const setup = async () => {
  const tenant = await createTestTenant(); // SPARK: no paid tickets, no public events on its plan
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  cleanup.push(
    async () => {
      const events = await prisma.event.findMany({ where: { tenantId: tenant.id }, select: { id: true } });
      for (const { id } of events) {
        const guests = await prisma.guest.findMany({ where: { eventId: id }, select: { id: true } });
        for (const g of guests) await deleteTestGuest(g.id);
        await prisma.eventDay.deleteMany({ where: { eventId: id } });
        await deleteTestEvent(id);
      }
    },
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  const makeEvent = async (data: Record<string, unknown>) => {
    const event = await eventRepository.create(tenant.id, organiser.id, { name: `Gap ${randomUUID()}`, ...data });
    const day = await createTestEventDay(event.id, organiser.id);
    return { event, day };
  };
  const update = (id: string, data: Record<string, unknown>) =>
    eventService.update(id, organiser.id, 'TENANT_ADMIN', tenant.id, data);
  return { tenant, organiser, makeEvent, update };
};

describe('ticketing off — an older paid event stays editable', () => {
  it('a full-form save re-sending ticketing PAID succeeds while off', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({ ticketing: 'PAID' });

    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    const saved = await update(event.id, { name: 'Renamed paid event', ticketing: 'PAID' });
    expect(saved).toMatchObject({ name: 'Renamed paid event', ticketing: 'PAID' });

    // An edit that leaves ticketing out entirely, too.
    await expect(update(event.id, { description: 'Still paid' })).resolves.toMatchObject({ ticketing: 'PAID' });
  }, 60000);

  it('flag on: the same save still goes through the plan check (the control)', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({ ticketing: 'PAID' });
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(update(event.id, { name: 'Renamed', ticketing: 'PAID' })).rejects.toMatchObject({ statusCode: 403 });
  }, 60000);

  it('changing FREE to PAID is still 422 while off', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({});
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    await expect(update(event.id, { ticketing: 'PAID' })).rejects.toMatchObject({ statusCode: 422, message: TICKETING_UNAVAILABLE_MESSAGE });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).ticketing).toBe('FREE');
  }, 60000);

  it('switching an older paid event to FREE is allowed while off', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({ ticketing: 'PAID' });
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    await expect(update(event.id, { ticketing: 'FREE' })).resolves.toMatchObject({ ticketing: 'FREE' });
  }, 60000);
});

describe('publicEvents off — an older public event stays editable', () => {
  it('a full-form save re-sending visibility PUBLIC succeeds while off', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({ visibility: 'PUBLIC' });
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    await expect(update(event.id, { name: 'Renamed public event', visibility: 'PUBLIC' }))
      .resolves.toMatchObject({ name: 'Renamed public event', visibility: 'PUBLIC' });
  }, 60000);

  it('flag on: the same save still goes through the plan check (the control)', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({ visibility: 'PUBLIC' });
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(update(event.id, { name: 'Renamed', visibility: 'PUBLIC' })).rejects.toMatchObject({ statusCode: 403 });
  }, 60000);

  it('changing PRIVATE to PUBLIC is still 422 while off', async () => {
    const { makeEvent, update } = await setup();
    const { event } = await makeEvent({});
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    await expect(update(event.id, { visibility: 'PUBLIC' })).rejects.toMatchObject({ statusCode: 422, message: PUBLIC_EVENTS_UNAVAILABLE_MESSAGE });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).visibility).toBe('PRIVATE');
  }, 60000);
});

describe('sms off — the guest import template', () => {
  const readTemplate = async (buffer: Buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Guests')!;
    const note = sheet.getCell('C1').note;
    const noteText = typeof note === 'string' ? note : (note?.texts ?? []).map((t) => t.text).join('');
    const contacts = [2, 3, 4].map((r) => String(sheet.getCell(`C${r}`).value ?? ''));
    return { noteText, contacts };
  };

  it('off: asks for an email for every guest, examples are emails, and the template imports as-is', async () => {
    const { tenant, organiser, makeEvent } = await setup();
    const { event } = await makeEvent({});
    vi.stubEnv('FEATURES_DISABLED', 'sms');

    const { buffer } = await guestService.getImportTemplate(event.id, 'TENANT_ADMIN', tenant.id);
    const { noteText, contacts } = await readTemplate(buffer);
    expect(noteText).toContain("Every guest needs an email address: text messages aren't available yet.");
    expect(noteText).not.toMatch(/phone/i);
    for (const c of contacts) expect(c).toMatch(/@example\.com$/);

    const result = await guestService.importGuests(event.id, organiser.id, 'TENANT_ADMIN', tenant.id, {
      buffer, originalname: 'template.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(result).toMatchObject({ totalRows: 3, created: 3, failed: 0 });
  }, 60000);

  it('on: the wording and examples stay as today', async () => {
    const { tenant, makeEvent } = await setup();
    const { event } = await makeEvent({});
    vi.stubEnv('FEATURES_DISABLED', '');
    const { buffer } = await guestService.getImportTemplate(event.id, 'TENANT_ADMIN', tenant.id);
    const { noteText, contacts } = await readTemplate(buffer);
    expect(noteText).toContain('Enter one email OR one phone number (e.g. +27 82 123 4567) per guest — not both.');
    expect(noteText).not.toContain('E.164');
    expect(contacts).toEqual(['john.smith@example.com', '+27821234567', '+27831234567']);
  }, 60000);
});
