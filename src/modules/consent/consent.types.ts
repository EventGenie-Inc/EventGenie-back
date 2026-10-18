import { type ConsentAction, type ConsentKind } from '@prisma/client';

// The permissions an organiser gives for the whole event (one tick each on
// the feedback form). The per-photo ones are PHOTO_ORGANISER_SELECTED (the
// organiser's selection) and PHOTO_GUEST_PUBLIC_SHARING (the guest's own).
export const EVENT_CONSENT_KINDS = ['COMPANY_NAME_LOGO', 'QUOTE', 'CASE_STUDY_CONTACT'] as const;
export type EventConsentKind = (typeof EVENT_CONSENT_KINDS)[number];

export const PHOTO_CONSENT_KINDS = ['PHOTO_ORGANISER_SELECTED', 'PHOTO_GUEST_PUBLIC_SHARING'] as const;

// One new record. Exactly one of userId (an organiser) or guestId (the
// uploading guest); memoryItemId for the photo kinds only. The wording is
// never passed in: consentService.record stores the current wording for
// the kind (consent-wording.ts).
export interface NewConsentRecord {
  eventId: string;
  kind: ConsentKind;
  memoryItemId: string | null;
  userId: string | null;
  guestId: string | null;
  action: ConsentAction;
}

export interface ConsentRecordRow {
  seq: number;
  kind: ConsentKind;
  memoryItemId: string | null;
  action: ConsentAction;
  wordingVersion: number;
  recordedAt: Date;
}

// A subject's current state, folded from its records (consent-state.util.ts).
// NOT_GIVEN: no record at all. When WITHDRAWN, givenAt and wordingVersion
// describe the grant that was withdrawn.
export type ConsentStatus = 'GRANTED' | 'WITHDRAWN' | 'NOT_GIVEN';

export interface ConsentState {
  status: ConsentStatus;
  granted: boolean;
  givenAt: Date | null;
  wordingVersion: number | null;
  withdrawnAt: Date | null;
}
