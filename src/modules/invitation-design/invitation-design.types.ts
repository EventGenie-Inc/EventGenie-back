import { type InvitationFont } from './invitation-design-fonts.js';
import { type CanvasFormat } from './canvas-design.constants.js';

// ─────────────────────────────────────────
//  OVERRIDES — the ONLY per-element properties an organiser may change.
//  Every other key is rejected (invitation-design-validation.util.ts):
//  no free-form CSS, ever.
// ─────────────────────────────────────────
export interface InvitationElementOverride {
  color?: string;           // #rrggbb
  backgroundColor?: string; // #rrggbb
  fontFamily?: InvitationFont;
  fontSize?: number;        // template canvas units, see INVITATION_FONT_SIZE_MIN/MAX
  text?: string;            // at most 300 characters
}

export interface InvitationOverrides {
  elements: Record<string, InvitationElementOverride>;
}

// PUT body — a discriminated union on `kind`. Arrives as unknown JSON and
// is narrowed by assertValidDesignInput, never trusted as typed.
export interface PutTemplateDesignDto {
  kind: 'TEMPLATE';
  templateId: string;
  templateVersion: number;
  overrides: InvitationOverrides;
}

export interface PutUploadDesignDto {
  kind: 'UPLOAD';
  imageUrl: string;
  cloudinaryPublicId: string;
  width: number;
  height: number;
  altText?: string | null;
  // What the browser says the upload weighed: accepted, never used. The
  // size checked is Cloudinary's own (storedFileService.acceptUpload).
  bytes?: number;
}

export type PutInvitationDesignDto = PutTemplateDesignDto | PutUploadDesignDto;

// ─────────────────────────────────────────
//  CANVAS — the organiser's own design, made in the editor.
// ─────────────────────────────────────────

// The PUT body for a CANVAS design, as checked (canvas-design-input.util.ts).
// `svg` is the browser's export, cleaned before it is stored;
// `pngPublicId` is the rendered card's upload (signed through
// canvas-upload-signature with purpose RENDER), as Cloudinary reported it.
export interface PutCanvasDesignDto {
  kind: 'CANVAS';
  format: CanvasFormat;
  document: Record<string, unknown>;
  documentVersion: number;
  svg: string;
  pngPublicId: string;
  envelopeColor: string;
  sealColor: string;
  altText: string;
}

// What a CANVAS row stores (the repository's input).
export interface CanvasDesignColumns {
  kind: 'CANVAS';
  format: CanvasFormat;
  document: Record<string, unknown>;
  documentVersion: number;
  svgMarkup: string;
  pngStoredFileId: string;
  envelopeColor: string;
  sealColor: string;
  altText: string;
  hasRsvpButton: boolean;
}

export type StoredDesignColumns = PutInvitationDesignDto | CanvasDesignColumns;

// Guest-facing projection (RSVP validate only). No ids, no audit fields, no
// publicId, and never a CANVAS design's document — see STEERING
// "Guest-facing responses".
export type GuestInvitationDesign =
  | { kind: 'TEMPLATE'; templateId: string; templateVersion: number; overrides: InvitationOverrides }
  | { kind: 'UPLOAD'; imageUrl: string; width: number; height: number; altText: string | null }
  | {
      kind: 'CANVAS';
      format: CanvasFormat;
      svg: string;
      pngUrl: string | null;
      altText: string | null;
      envelopeColor: string;
      sealColor: string;
      hasRsvpButton: boolean;
    };
