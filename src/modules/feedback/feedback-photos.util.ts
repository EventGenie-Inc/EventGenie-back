import { type ConsentState } from '../consent/consent.types.js';
import { consentStateOf, consentSubjectKey } from '../consent/consent.service.js';
import { isSignedPublicIdInFolder, memoryHubFolder } from '../upload/upload-folders.js';

// ─────────────────────────────────────────
//  WHICH PHOTOS — decided here and only here
//
//  ELIGIBLE (the organiser may select it): approved, not archived, a photo
//  a guest uploaded to the event's live album (feedbackRepository's
//  findApprovedGuestPhotos), in the event's own folder, AND its guest's
//  public-sharing opt-in is currently granted.
//
//  SHAREABLE (the super admin may use it): eligible AND the organiser's
//  selection of it is currently granted. Every condition, every time: a
//  photo rejected or archived since, or whose guest or organiser has since
//  withdrawn, drops out with no other step.
// ─────────────────────────────────────────

export interface CandidatePhoto {
  id: string;
  cloudinaryPublicId: string;
}

export const isPhotoEligible = (
  photo: CandidatePhoto,
  ctx: { tenantId: string; eventId: string; states: Map<string, ConsentState> }
): boolean =>
  isSignedPublicIdInFolder(photo.cloudinaryPublicId, memoryHubFolder(ctx.tenantId, ctx.eventId)) &&
  consentStateOf(ctx.states, 'PHOTO_GUEST_PUBLIC_SHARING', photo.id).granted;

export const isPhotoShareable = (
  photo: CandidatePhoto,
  ctx: { tenantId: string; eventId: string; states: Map<string, ConsentState> }
): boolean => isPhotoEligible(photo, ctx) && consentStateOf(ctx.states, 'PHOTO_ORGANISER_SELECTED', photo.id).granted;

// The ids of every photo the organiser has currently selected, eligible or
// not (one may have lost its guest's opt-in since).
export const selectedPhotoIdsOf = (states: Map<string, ConsentState>): string[] => {
  const prefix = consentSubjectKey('PHOTO_ORGANISER_SELECTED', null);
  return [...states.entries()]
    .filter(([key, state]) => key.startsWith(prefix) && state.granted)
    .map(([key]) => key.slice(prefix.length));
};
