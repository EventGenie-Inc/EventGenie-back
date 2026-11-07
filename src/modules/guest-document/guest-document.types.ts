// Dependency-free: rsvp-answers.util.ts and rsvp-field-validation.util.ts
// import these codes, and the service imports both of those.

export const DOCUMENT_ERROR_CODES = {
  // A required DOCUMENT question with no file attached, from someone
  // attending (422). Told apart from RSVP_ANSWER_REQUIRED: the form shows
  // the upload, not a text box.
  REQUIRED: 'DOCUMENT_REQUIRED',
  // Not a PDF, JPG, PNG or XLSX by its content, or named as another
  // type (422; guest-document-content.util.ts).
  TYPE_NOT_ALLOWED: 'DOCUMENT_TYPE_NOT_ALLOWED',
  // Over the plan's size per document, or the route's fixed ceiling (413,
  // like a guest import's). guest-document-allowance.util.ts.
  TOO_LARGE: 'DOCUMENT_TOO_LARGE',
  // The upload would take the event's documents over the plan's document
  // storage (403), checked under the event's row lock. Guest-safe words.
  STORAGE_FULL: 'DOCUMENT_STORAGE_FULL',
  // An answer naming a document that isn't this guest's (or this
  // registration's) upload for this question on this event, or that has
  // been deleted (422). One code and one message for every cause.
  REFERENCE_INVALID: 'DOCUMENT_REFERENCE_INVALID',
  // documentFields is off: no upload, and no DOCUMENT question can be added
  // or a question changed to one (422).
  FIELDS_UNAVAILABLE: 'DOCUMENT_FIELDS_UNAVAILABLE',
} as const;

export const DOCUMENT_FIELDS_UNAVAILABLE_MESSAGE = "File uploads aren't available right now.";

// The guest's view of their own uploaded file (the upload's answer, and
// /rsvp/validate's `documents`). An explicit allowlist: never the row.
export interface GuestDocumentView {
  id: string;
  rsvpFieldId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
}

// What the organiser's guest details show for an answered DOCUMENT
// question: whether a file was received, and what it is. No link: that is
// the view endpoint's, minted on demand.
export interface OrganiserDocumentInfo {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
}

// One row of GET /api/events/:eventId/documents. guest: null for an
// answer with no invite (none today: a registration's is attached to the
// invite it creates). isArchived: the guest or their invite was removed.
export interface OrganiserDocumentListItem {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
  question: { id: string; label: string };
  guest: { id: string; firstName: string | null; surname: string | null; isArchived: boolean } | null;
}

export interface DocumentLinkView {
  url: string;
  expiresAt: Date;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}
