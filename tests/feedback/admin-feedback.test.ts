import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { createActor, createTenant, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { consentService } from '../../src/modules/consent/consent.service.js';
import { csvCell } from '../../src/modules/feedback/feedback-export.util.js';
import { DOWNLOAD_LINK_TTL_MS } from '../../src/modules/memory-hub/memory-hub-download.service.js';
import { addPhoto, cleanupTenants, newEvent, newGuest, setGuestSharing } from './helpers.js';

// ─────────────────────────────────────────
//  SUPER ADMIN — /api/admin/feedback
//
//  The list (each permission's current state, when given, the wording
//  version, withdrawals marked), each event's SHAREABLE photos (approved,
//  live, the guest's opt-in granted AND the organiser's selection granted,
//  every condition, now) with short-lived download links, and the CSV.
//  Every route is the global 404 for anyone but a SUPER_ADMIN.
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 90_000 });

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let eventAdmin: Actor;
let superAdmin: Actor;

beforeAll(async () => {
  const tenant = await createTenant(`Acme Holdings ${Date.now()}`);
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventAdmin = await createActor('EVENT_ADMIN', tenant.id);
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 60000);

beforeEach(() => {
  installFirebaseMock();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await cleanupTenants(tenantIds.splice(0));
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120000);

const putFeedback = (eventId: string, body: object) =>
  request(app).put(`/api/events/${eventId}/feedback`).set(headersFor(organiser)).send(body);
const shareable = (eventId: string, actor: Actor = superAdmin) =>
  request(app).get(`/api/admin/feedback/${eventId}/shareable-photos`).set(headersFor(actor));
const organiserSelect = (eventId: string, memoryItemId: string, granted: boolean) =>
  consentService.record([
    { eventId, kind: 'PHOTO_ORGANISER_SELECTED', memoryItemId, userId: organiser.id, guestId: null, action: granted ? 'GRANTED' : 'WITHDRAWN' },
  ]);

// An event with feedback and four photos, each opted in by its guest and
// selected by the organiser: all four shareable to begin with.
const setup = async () => {
  const ev = await newEvent(tenantId, organiser.id);
  const { guest } = await newGuest(ev.event.id, organiser.id);
  const photos = [];
  for (let i = 0; i < 4; i += 1) {
    const p = await addPhoto(ev, { guestId: guest.id });
    await setGuestSharing(ev.event.id, guest.id, p.id, true);
    photos.push(p);
  }
  expect((await putFeedback(ev.event.id, { score: 10, selectedPhotoIds: photos.map((p) => p.id) })).status).toBe(200);
  return { ev, guest, photos };
};

const shareableIds = async (eventId: string): Promise<string[]> => {
  const res = await shareable(eventId);
  expect(res.status).toBe(200);
  return res.body.data.photos.map((p: { id: string }) => p.id).sort();
};

describe('shareable photos: every condition, now', () => {
  it('starts with all four; a guest withdrawal, an organiser withdrawal, a rejection and an archive each remove exactly one', async () => {
    const { ev, guest, photos } = await setup();
    const [a, b, c, d] = photos as [typeof photos[0], typeof photos[0], typeof photos[0], typeof photos[0]];
    expect(await shareableIds(ev.event.id)).toEqual(photos.map((p) => p.id).sort());

    await setGuestSharing(ev.event.id, guest.id, a.id, false);
    expect(await shareableIds(ev.event.id)).not.toContain(a.id);

    await organiserSelect(ev.event.id, b.id, false);
    expect(await shareableIds(ev.event.id)).not.toContain(b.id);

    await prisma.memoryItem.update({ where: { id: c.id }, data: { status: 'REJECTED' } });
    await prisma.memoryItem.update({ where: { id: d.id }, data: { isArchived: true } });
    expect(await shareableIds(ev.event.id)).toEqual([]);
    expect((await shareable(ev.event.id)).body.data.download).toBeNull();

    // The organiser withdrawing through the form drops it too.
    await setGuestSharing(ev.event.id, guest.id, a.id, true);
    expect(await shareableIds(ev.event.id)).toEqual([a.id]);
    await putFeedback(ev.event.id, { selectedPhotoIds: [] });
    expect(await shareableIds(ev.event.id)).toEqual([]);
  });

  it("a guest opt-in without the organiser's selection, or a selection without the opt-in, is not shareable", async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const optedInOnly = await addPhoto(ev, { guestId: guest.id });
    const selectedOnly = await addPhoto(ev, { guestId: guest.id });
    await setGuestSharing(ev.event.id, guest.id, optedInOnly.id, true);
    await putFeedback(ev.event.id, { score: 7 });
    await organiserSelect(ev.event.id, selectedOnly.id, true);
    expect(await shareableIds(ev.event.id)).toEqual([]);
  });

  it('each photo carries both consents, and the download links name exactly the shareable originals for 30 minutes', async () => {
    const { ev, guest, photos } = await setup();
    await setGuestSharing(ev.event.id, guest.id, photos[0]!.id, false);

    const before = Date.now();
    const res = await shareable(ev.event.id);
    const { data } = res.body;
    expect(data.photos[0]).toMatchObject({
      guestConsent: { wordingVersion: 1 },
      organiserSelection: { wordingVersion: 1 },
    });
    expect(data.photos[0].guestConsent.givenAt).toEqual(expect.any(String));
    expect(data.download.parts).toHaveLength(1);

    const url = new URL(data.download.parts[0].url);
    expect(url.pathname).toMatch(/\/image\/generate_archive$/);
    expect(url.searchParams.getAll('public_ids[]').sort()).toEqual(photos.slice(1).map((p) => p.cloudinaryPublicId).sort());
    const expiresAt = Number(url.searchParams.get('expires_at')) * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + DOWNLOAD_LINK_TTL_MS - 2000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + DOWNLOAD_LINK_TTL_MS + 1000);
    expect(data.download.parts[0].fileName).toMatch(/^shareable-Feedback-Event-[\w-]+-photos\.zip$/);
  });
});

describe('the list', () => {
  it('each permission with its state, when given and the wording version; a withdrawal clearly marked', async () => {
    const ev = await newEvent(tenantId, organiser.id, { name: 'Year-end function' });
    await putFeedback(ev.event.id, {
      score: 9,
      workedBest: 'The RSVP page',
      toImprove: 'More templates',
      permissions: { COMPANY_NAME_LOGO: true, QUOTE: true },
    });
    await putFeedback(ev.event.id, { permissions: { QUOTE: false } });

    const res = await request(app).get('/api/admin/feedback').set(headersFor(superAdmin));
    expect(res.status).toBe(200);
    const entry = res.body.data.find((e: { eventId: string }) => e.eventId === ev.event.id);
    expect(entry).toMatchObject({
      eventName: 'Year-end function',
      companyName: expect.stringContaining('Acme Holdings'),
      score: 9,
      workedBest: 'The RSVP page',
      toImprove: 'More templates',
      permissions: {
        COMPANY_NAME_LOGO: { status: 'GRANTED', wordingVersion: 1, withdrawnAt: null },
        QUOTE: { status: 'WITHDRAWN', wordingVersion: 1 },
        CASE_STUDY_CONTACT: { status: 'NOT_GIVEN', givenAt: null, wordingVersion: null, withdrawnAt: null },
      },
      photos: { selectedCount: 0, shareableCount: 0 },
    });
    expect(entry.permissions.QUOTE.givenAt).toEqual(expect.any(String));
    expect(entry.permissions.QUOTE.withdrawnAt).toEqual(expect.any(String));
    expect(entry.eventStartDate).toEqual(expect.any(String));
  });

  it('the CSV export has a row per feedback, withdrawals marked, and organiser text defused for spreadsheets', async () => {
    const ev = await newEvent(tenantId, organiser.id, { name: '=HYPERLINK("http://evil.test","x")' });
    await putFeedback(ev.event.id, { score: 6, workedBest: '+SUM(A1:A9)', toImprove: 'Line one\nline "two"', permissions: { QUOTE: true } });
    await putFeedback(ev.event.id, { permissions: { QUOTE: false } });

    const res = await request(app).get('/api/admin/feedback/export').set(headersFor(superAdmin));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="e-velope-feedback-\d{4}-\d{2}-\d{2}\.csv"$/);
    const csv = res.text;
    expect(csv.startsWith('﻿Event,Company,Event date,')).toBe(true);
    const row = csv.split('\r\n').find((line) => line.includes('HYPERLINK'));
    expect(row).toBeDefined();
    expect(row!.startsWith(`"'=HYPERLINK(""http://evil.test"",""x"")"`)).toBe(true);
    expect(csv).toContain(`'+SUM(A1:A9)`);
    expect(csv).toContain('"Line one\nline ""two"""');
    expect(csv).toMatch(/WITHDRAWN \d{4}-\d{2}-\d{2} \(given \d{4}-\d{2}-\d{2}, wording v1\)/);
  });

  it('csvCell: quotes what needs quoting and defuses every formula start', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(7)).toBe('7');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
    for (const start of ['=', '+', '-', '@', '\t', '\r']) expect(csvCell(`${start}1`).replace(/^"/, '').startsWith(`'${start}`)).toBe(true);
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});

describe('super admin only', () => {
  it('every route is the global 404 for a tenant admin and an event admin', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    for (const actor of [organiser, eventAdmin]) {
      for (const path of ['/api/admin/feedback', '/api/admin/feedback/export', `/api/admin/feedback/${event.id}/shareable-photos`]) {
        const res = await request(app).get(path).set(headersFor(actor));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ status: 'error', message: 'Route not found' });
      }
    }
  });

  it('an event with no feedback, or no such event, is a 404 to the super admin', async () => {
    const { event } = await newEvent(tenantId, organiser.id);
    expect((await shareable(event.id)).status).toBe(404);
    expect((await shareable('no-such-event')).status).toBe(404);
  });
});
