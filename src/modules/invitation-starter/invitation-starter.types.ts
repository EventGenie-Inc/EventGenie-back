import { type InvitationStarterCategory, type InvitationStarterStatus } from '@prisma/client';
import { type CanvasFormat } from '../invitation-design/canvas-design.constants.js';

// ─────────────────────────────────────────
//  STARTER DESIGNS (STEERING "Invitation designs: starter designs")
// ─────────────────────────────────────────

export const STARTER_CATEGORIES: readonly InvitationStarterCategory[] = [
  'WEDDING', 'BIRTHDAY', 'KIDS_PARTY', 'GRADUATION', 'BABY_SHOWER',
  'CORPORATE', 'NETWORKING', 'RELIGIOUS', 'YEAR_END', 'OTHER',
];
export const STARTER_STATUSES: readonly InvitationStarterStatus[] = ['DRAFT', 'PUBLISHED', 'RETIRED'];

export const STARTER_NAME_MAX_CHARS = 60;

export const STARTER_ERROR_CODES = {
  // Unknown, a draft or retired (organisers); unknown (super admin).
  NOT_FOUND: 'INVITATION_STARTER_NOT_FOUND',
  // A field of the starter itself: name, category, unknown keys, a design
  // sent in part, the format changed without its design.
  FIELD_INVALID: 'INVITATION_STARTER_FIELD_INVALID',
  // Publishing one that isn't finished (no design, preview, colours or alt
  // text), or whose design no longer passes the checks.
  INCOMPLETE: 'INVITATION_STARTER_INCOMPLETE',
  // A status change that doesn't apply from the current status.
  STATUS_CONFLICT: 'INVITATION_STARTER_STATUS_CONFLICT',
  // Deleting one that was ever published (retire it instead).
  WAS_PUBLISHED: 'INVITATION_STARTER_WAS_PUBLISHED',
  // Reordering with a list that isn't every starter exactly once.
  ORDER_INVALID: 'INVITATION_STARTER_ORDER_INVALID',
  // One of a published starter's images is gone, so it can't be copied.
  UNAVAILABLE: 'INVITATION_STARTER_UNAVAILABLE',
  // An upload signature for something other than ASSET or PREVIEW.
  UPLOAD_PURPOSE_INVALID: 'INVITATION_STARTER_UPLOAD_PURPOSE_INVALID',
} as const;

// A create or update, as checked (invitation-starter-input.util.ts). The
// design (document, documentVersion, svg, previewPublicId) comes whole or not
// at all; the format changes only with it.
export interface StarterDesignInput {
  document: Record<string, unknown>;
  documentVersion: number;
  svg: string;
  previewPublicId: string;
}

export interface StarterInput {
  name?: string;
  category?: InvitationStarterCategory;
  format?: CanvasFormat;
  design?: StarterDesignInput;
  envelopeColor?: string;
  sealColor?: string;
  altText?: string;
}

// The super admin's list: everything but the document and the SVG.
export interface AdminStarterSummary {
  id: string;
  name: string;
  category: InvitationStarterCategory;
  format: CanvasFormat;
  status: InvitationStarterStatus;
  sortOrder: number;
  publishedAt: Date | null;
  previewUrl: string | null;
  envelopeColor: string | null;
  sealColor: string | null;
  altText: string | null;
  hasDesign: boolean;
  hasRsvpButton: boolean | null;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

// One, for the super admin's editor: the summary and the design.
export interface AdminStarterDetail extends AdminStarterSummary {
  document: unknown;
  documentVersion: number | null;
  svgMarkup: string | null;
  previewPublicId: string | null;
}

// GET /api/invitation-starters (organisers): only what the picker shows.
export interface StarterCard {
  id: string;
  name: string;
  category: InvitationStarterCategory;
  format: CanvasFormat;
  previewUrl: string | null;
  envelopeColor: string;
  sealColor: string;
}

// POST /api/events/:eventId/invitation-design/from-starter: the organiser's
// own copy to edit, its images now this event's unsaved files. Not saved.
export interface StarterCopy {
  starterId: string;
  name: string;
  format: CanvasFormat;
  document: unknown;
  documentVersion: number;
  envelopeColor: string;
  sealColor: string;
  altText: string;
}
