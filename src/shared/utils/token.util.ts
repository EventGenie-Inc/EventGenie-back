import crypto from 'crypto';

// ─────────────────────────────────────────
//  SECURE TOKEN GENERATOR
//
//  256 random bits, hex-encoded — the same shape invite.repository.ts's
//  Invite.token, event.repository.ts's Event.shareToken, and
//  memory-hub.repository.ts's MemoryHub.shareToken already use
//  (`crypto.randomBytes(32).toString('hex')`, inline, at each of those
//  three call sites). This file didn't exist as anything but an empty
//  stub before the Trusted Devices batch — those three sites still
//  generate inline rather than import from here (flagged, not changed,
//  out of that batch's scope). DeviceToken is the first consumer of the
//  file actually being filled in, and the intent is for future token
//  generation — inline or shared — to converge on this rather than growing
//  a fourth ad hoc copy of the same one-liner.
// ─────────────────────────────────────────
export const generateSecureToken = (): string => crypto.randomBytes(32).toString('hex');
