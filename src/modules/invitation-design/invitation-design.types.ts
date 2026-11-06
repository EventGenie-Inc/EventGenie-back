import { type InvitationFont } from './invitation-design-fonts.js';

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

// Guest-facing projection (RSVP validate, public event page). No ids, no
// audit fields, no publicId — see STEERING "Guest-facing responses".
export type GuestInvitationDesign =
  | { kind: 'TEMPLATE'; templateId: string; templateVersion: number; overrides: InvitationOverrides }
  | { kind: 'UPLOAD'; imageUrl: string; width: number; height: number; altText: string | null };
