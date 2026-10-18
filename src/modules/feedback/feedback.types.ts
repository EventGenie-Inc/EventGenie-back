import { type EventConsentKind } from '../consent/consent.types.js';

// PUT /api/events/:eventId/feedback. Everything arrives unchecked from the
// request body; feedback-validation.util.ts turns it into SaveFeedbackInput.
// A field left out is left as it is; score is required on the first save.
export interface SaveFeedbackBody {
  score?: unknown;
  workedBest?: unknown;
  toImprove?: unknown;
  // { COMPANY_NAME_LOGO?: boolean, QUOTE?: boolean, CASE_STUDY_CONTACT?: boolean }
  permissions?: unknown;
  // The whole selection, like assignments: photos added are granted,
  // photos missing are withdrawn.
  selectedPhotoIds?: unknown;
  // { url, publicId, bytes } from the signed upload, or null to remove.
  logo?: unknown;
}

export interface FeedbackLogoInput {
  url: string;
  publicId: string;
  bytes: number | undefined;
}

export interface SaveFeedbackInput {
  score: number | undefined;
  // null: cleared (blank); undefined: left as it is.
  workedBest: string | null | undefined;
  toImprove: string | null | undefined;
  permissions: Partial<Record<EventConsentKind, boolean>>;
  selectedPhotoIds: string[] | undefined;
  logo: FeedbackLogoInput | null | undefined;
}
