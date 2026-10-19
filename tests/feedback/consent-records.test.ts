import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTenant, createActor, prisma, type Actor } from '../helpers/team.js';
import { consentRepository } from '../../src/modules/consent/consent.repository.js';
import { consentService, consentStateOf, foldConsentStates } from '../../src/modules/consent/consent.service.js';
import { CONSENT_WORDING_HISTORY, currentConsentWording } from '../../src/modules/consent/consent-wording.js';
import { cleanupTenants, newEvent, newGuest, addPhoto } from './helpers.js';

// ─────────────────────────────────────────
//  CONSENT RECORDS — append-only; the current state is the latest record
//
//  Every permission given or withdrawn is a new ConsentRecord. Nothing is
//  updated or deleted (no repository method, and the database refuses an
//  UPDATE). A subject's state is its latest record by seq, NOT_GIVEN with
//  none. Each record carries the wording it was given and its version.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

afterAll(async () => {
  await cleanupTenants(tenantIds.splice(0));
}, 120000);

const organiserRecord = (eventId: string, action: 'GRANTED' | 'WITHDRAWN') => ({
  eventId,
  kind: 'QUOTE' as const,
  memoryItemId: null,
  userId: organiser.id,
  guestId: null,
  action,
});

describe('append-only', () => {
  it('a withdrawal is a new record; the grant before it is left exactly as it was', async () => {
    const { event } = await newEvent(organiser.tenantId as string, organiser.id);

    await consentService.record([organiserRecord(event.id, 'GRANTED')]);
    const [grant] = await prisma.consentRecord.findMany({ where: { eventId: event.id } });

    await consentService.record([organiserRecord(event.id, 'WITHDRAWN')]);
    const rows = await prisma.consentRecord.findMany({ where: { eventId: event.id }, orderBy: { seq: 'asc' } });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(grant);
    expect(rows.map((r) => r.action)).toEqual(['GRANTED', 'WITHDRAWN']);
    expect(consentStateOf(await consentService.statesForEvent(event.id), 'QUOTE')).toMatchObject({
      status: 'WITHDRAWN',
      granted: false,
      givenAt: grant!.recordedAt,
      wordingVersion: 2,
      withdrawnAt: rows[1]!.recordedAt,
    });
  });

  it('the repository has no way to update or delete a record', () => {
    expect(Object.keys(consentRepository).sort()).toEqual(['appendMany', 'findForEvent', 'findForEvents', 'findForItems']);
  });

  it('the database refuses an UPDATE of a record, whoever runs it', async () => {
    const { event } = await newEvent(organiser.tenantId as string, organiser.id);
    await consentService.record([organiserRecord(event.id, 'GRANTED')]);
    const row = await prisma.consentRecord.findFirstOrThrow({ where: { eventId: event.id } });

    await expect(prisma.consentRecord.update({ where: { id: row.id }, data: { action: 'WITHDRAWN' } })).rejects.toThrow();
    expect(await prisma.consentRecord.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it('the database refuses a record naming both an organiser and a guest, or a photo kind without its photo', async () => {
    const { event } = await newEvent(organiser.tenantId as string, organiser.id);
    const { guest } = await newGuest(event.id, organiser.id);
    const wording = currentConsentWording('QUOTE');
    await expect(
      prisma.consentRecord.create({
        data: { eventId: event.id, kind: 'QUOTE', userId: organiser.id, guestId: guest.id, action: 'GRANTED', wording: wording.text, wordingVersion: 1 },
      })
    ).rejects.toThrow();
    await expect(
      prisma.consentRecord.create({
        data: { eventId: event.id, kind: 'PHOTO_GUEST_PUBLIC_SHARING', guestId: guest.id, action: 'GRANTED', wording: wording.text, wordingVersion: 1 },
      })
    ).rejects.toThrow();
  });
});

describe('the current state is the latest record', () => {
  it('no record is NOT_GIVEN; grant, withdraw, grant again ends GRANTED with the newest grant', async () => {
    const { event } = await newEvent(organiser.tenantId as string, organiser.id);
    expect(consentStateOf(await consentService.statesForEvent(event.id), 'QUOTE')).toEqual({
      status: 'NOT_GIVEN', granted: false, givenAt: null, wordingVersion: null, withdrawnAt: null,
    });

    await consentService.record([organiserRecord(event.id, 'GRANTED')]);
    await consentService.record([organiserRecord(event.id, 'WITHDRAWN')]);
    await consentService.record([organiserRecord(event.id, 'GRANTED')]);

    const rows = await prisma.consentRecord.findMany({ where: { eventId: event.id }, orderBy: { seq: 'asc' } });
    const state = consentStateOf(await consentService.statesForEvent(event.id), 'QUOTE');
    expect(state).toMatchObject({ status: 'GRANTED', granted: true, givenAt: rows[2]!.recordedAt, withdrawnAt: null });
  });

  it('records in the same millisecond still have a latest: seq decides, whatever order they arrive in', () => {
    const at = new Date('2026-10-16T10:00:00.000Z');
    const records = [
      { seq: 12, kind: 'QUOTE' as const, memoryItemId: null, action: 'WITHDRAWN' as const, wordingVersion: 1, recordedAt: at },
      { seq: 11, kind: 'QUOTE' as const, memoryItemId: null, action: 'GRANTED' as const, wordingVersion: 1, recordedAt: at },
    ];
    expect(consentStateOf(foldConsentStates(records), 'QUOTE').status).toBe('WITHDRAWN');
    expect(consentStateOf(foldConsentStates([...records].reverse()), 'QUOTE').status).toBe('WITHDRAWN');
  });

  it('each photo is its own subject: one photo withdrawn leaves another granted', async () => {
    const ev = await newEvent(organiser.tenantId as string, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const a = await addPhoto(ev, { guestId: guest.id });
    const b = await addPhoto(ev, { guestId: guest.id });
    const guestRecord = (memoryItemId: string, action: 'GRANTED' | 'WITHDRAWN') => ({
      eventId: ev.event.id, kind: 'PHOTO_GUEST_PUBLIC_SHARING' as const, memoryItemId, userId: null, guestId: guest.id, action,
    });
    await consentService.record([guestRecord(a.id, 'GRANTED'), guestRecord(b.id, 'GRANTED')]);
    await consentService.record([guestRecord(a.id, 'WITHDRAWN')]);

    const sharing = await consentService.guestSharingFor([a.id, b.id]);
    expect(sharing.get(a.id)).toBe(false);
    expect(sharing.get(b.id)).toBe(true);
  });
});

describe('wording', () => {
  it('each record stores the current wording and its version', async () => {
    const ev = await newEvent(organiser.tenantId as string, organiser.id);
    const { guest } = await newGuest(ev.event.id, organiser.id);
    const photo = await addPhoto(ev, { guestId: guest.id });
    await consentService.record([
      { eventId: ev.event.id, kind: 'PHOTO_GUEST_PUBLIC_SHARING', memoryItemId: photo.id, userId: null, guestId: guest.id, action: 'GRANTED' },
    ]);
    const row = await prisma.consentRecord.findFirstOrThrow({ where: { eventId: ev.event.id } });
    expect(row.wording).toBe('Happy for this photo to be shared publicly by the organiser and e-velope.');
    expect(row.wordingVersion).toBe(1);
  });

  it('every kind has a wording history with versions in order; the current one is the last', () => {
    for (const [kind, history] of Object.entries(CONSENT_WORDING_HISTORY)) {
      expect(history.length).toBeGreaterThan(0);
      history.forEach((entry, i) => {
        expect(entry.version).toBe(i + 1);
        expect(entry.text.trim()).not.toBe('');
      });
      expect(currentConsentWording(kind as keyof typeof CONSENT_WORDING_HISTORY)).toBe(history[history.length - 1]);
    }
  });
});
