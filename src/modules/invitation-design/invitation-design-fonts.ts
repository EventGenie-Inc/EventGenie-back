// ─────────────────────────────────────────
//  INVITATION DESIGN — FONT ALLOWLIST
//
//  The ONLY font families an organiser may pick for an invitation
//  template override. The frontend holds an exact copy of this list; the
//  two must always change together (STEERING, "Invitation designs").
//  Dependency-free on purpose, so the file can be copied as-is.
//
//  Built from:
//   a) every font-family used by the template SVGs in the frontend repo's
//      design/invitations/*/ (at v1: Poppins and Inter, both from
//      wedding/frame.svg; birthday/ has no SVG yet), and
//   b) a curated set for organiser choice.
//
//  Every entry is a Google Fonts family, spelled exactly as Google Fonts
//  spells it. Adding a template that uses a new font means adding that
//  font here first, and only if it is on Google Fonts.
//
//  Removing a font breaks every saved design that uses it (PUT would
//  start rejecting a re-save). Add freely; remove only with a plan for
//  the designs already saved with it.
// ─────────────────────────────────────────
export const INVITATION_FONT_ALLOWLIST = [
  'Poppins',
  'Inter',
  'Playfair Display',
  'Cormorant Garamond',
  'Lora',
  'Libre Baskerville',
  'DM Serif Display',
  'Montserrat',
  'Great Vibes',
  'Dancing Script',
] as const;

export type InvitationFont = (typeof INVITATION_FONT_ALLOWLIST)[number];
