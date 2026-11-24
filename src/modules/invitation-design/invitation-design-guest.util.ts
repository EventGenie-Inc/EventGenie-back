import { type InvitationDesign } from '@prisma/client';
import { requireCloudinaryConfig } from '../../shared/cloudinary/cloudinary.client.js';
import { type CanvasFormat } from './canvas-design.constants.js';
import { type GuestInvitationDesign, type InvitationOverrides } from './invitation-design.types.js';

// A CANVAS design's rendered card, as a Cloudinary delivery URL built from
// its StoredFile (this account's cloud, its public id, the format Cloudinary
// measured). Null without one, or with Cloudinary not configured.
export const designRenderUrl = (file: { publicId: string; format: string | null } | null | undefined): string | null => {
  if (!file) return null;
  let cloudName: string;
  try {
    cloudName = requireCloudinaryConfig().cloudName;
  } catch {
    return null;
  }
  return `https://res.cloudinary.com/${cloudName}/image/upload/${file.publicId}.${file.format === 'webp' ? 'webp' : 'png'}`;
};

// The row as the guest read gives it: every column but the CANVAS
// document (never read for a guest: invite.repository.ts omits it), and
// the rendered card's file.
export type GuestDesignRow = Omit<InvitationDesign, 'document'> & {
  pngStoredFile?: { publicId: string; format: string | null } | null;
};

// Guest-facing projection of an InvitationDesign row, for rsvp.service.ts's
// validate() (the only guest route that sends a design: the public event
// view never has). An explicit allowlist, never a spread of the row (STEERING
// "Guest-facing responses"): no id, eventId, audit fields, isArchived or
// cloudinaryPublicId, and for a CANVAS design never its document, only the
// cleaned SVG. Kept apart from invitation-design.service.ts so the guest
// modules don't import eventService just for this.
export const toGuestDesign = (design: GuestDesignRow | null | undefined): GuestInvitationDesign | null => {
  if (!design) return null;
  if (design.kind === 'TEMPLATE') {
    return {
      kind: 'TEMPLATE',
      templateId: design.templateId as string,
      templateVersion: design.templateVersion as number,
      overrides: design.overrides as unknown as InvitationOverrides,
    };
  }
  if (design.kind === 'CANVAS') {
    return {
      kind: 'CANVAS',
      format: design.format as CanvasFormat,
      svg: design.svgMarkup as string,
      pngUrl: designRenderUrl(design.pngStoredFile),
      altText: design.altText,
      envelopeColor: design.envelopeColor as string,
      sealColor: design.sealColor as string,
      hasRsvpButton: design.hasRsvpButton === true,
    };
  }
  return {
    kind: 'UPLOAD',
    imageUrl: design.imageUrl as string,
    width: design.width as number,
    height: design.height as number,
    altText: design.altText,
  };
};
