import { type ConsentKind, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { consentRepository } from './consent.repository.js';
import { currentConsentWording } from './consent-wording.js';
import { type ConsentRecordRow, type ConsentState, type NewConsentRecord } from './consent.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  CONSENT — the one place permissions are recorded and read back
//
//  A subject is an event + kind, plus the photo for the photo kinds. Its
//  current state is its LATEST record (highest seq): GRANTED or WITHDRAWN,
//  and NOT_GIVEN when it has none. Nothing is ever updated; changing your
//  mind appends a record.
// ─────────────────────────────────────────

export const consentSubjectKey = (kind: ConsentKind, memoryItemId: string | null): string =>
  `${kind}:${memoryItemId ?? ''}`;

const NOT_GIVEN: ConsentState = { status: 'NOT_GIVEN', granted: false, givenAt: null, wordingVersion: null, withdrawnAt: null };

// Folds records (any order) into each subject's current state, keyed by
// consentSubjectKey. A withdrawal keeps the grant it withdrew (givenAt,
// wordingVersion) so a screen can say what had been given and when.
export const foldConsentStates = (records: ConsentRecordRow[]): Map<string, ConsentState> => {
  const states = new Map<string, ConsentState>();
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const key = consentSubjectKey(record.kind, record.memoryItemId);
    const previous = states.get(key) ?? NOT_GIVEN;
    states.set(
      key,
      record.action === 'GRANTED'
        ? { status: 'GRANTED', granted: true, givenAt: record.recordedAt, wordingVersion: record.wordingVersion, withdrawnAt: null }
        : { status: 'WITHDRAWN', granted: false, givenAt: previous.givenAt, wordingVersion: previous.wordingVersion, withdrawnAt: record.recordedAt }
    );
  }
  return states;
};

export const consentStateOf = (states: Map<string, ConsentState>, kind: ConsentKind, memoryItemId: string | null = null): ConsentState =>
  states.get(consentSubjectKey(kind, memoryItemId)) ?? NOT_GIVEN;

export const consentService = {
  // Appends one record per entry, each with the CURRENT wording for its kind.
  record: (records: NewConsentRecord[], db: Db = prisma) =>
    consentRepository.appendMany(
      records.map((r) => {
        const wording = currentConsentWording(r.kind);
        return { ...r, wording: wording.text, wordingVersion: wording.version };
      }),
      db
    ),

  statesForEvent: async (eventId: string, db: Db = prisma): Promise<Map<string, ConsentState>> =>
    foldConsentStates(await consentRepository.findForEvent(eventId, db)),

  // statesForEvent for many events at once (one query), by event id.
  statesForEvents: async (eventIds: string[]): Promise<Map<string, Map<string, ConsentState>>> => {
    const records = await consentRepository.findForEvents(eventIds);
    return new Map(eventIds.map((id) => [id, foldConsentStates(records.filter((r) => r.eventId === id))]));
  },

  // The guests' own opt-in for each of these photos: true only while their
  // latest record is a grant. Default (no record) is false.
  guestSharingFor: async (memoryItemIds: string[], db: Db = prisma): Promise<Map<string, boolean>> => {
    const states = foldConsentStates(await consentRepository.findForItems(memoryItemIds, 'PHOTO_GUEST_PUBLIC_SHARING', db));
    return new Map(memoryItemIds.map((id) => [id, consentStateOf(states, 'PHOTO_GUEST_PUBLIC_SHARING', id).granted]));
  },
};
