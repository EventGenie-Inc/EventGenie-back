import crypto from 'crypto';
import { inviteRepository } from './invite.repository.js';
import { isUniqueViolationOn } from '../../shared/utils/prisma-error.util.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';

// ─────────────────────────────────────────
//  SHORT LINKS FOR TEXT MESSAGES
//
//  The guest's full link (/rsvp?token=<64 hex>) is 98 of an SMS's 160
//  characters on production, which left the host's and event's names a
//  few characters each. A text carries <FRONTEND_BASE_URL>/r/<shortCode>
//  instead (39 characters on production, https://www.e-velope.co.za/r/…):
//  the frontend's /r/:code page swaps the code for the token (POST
//  /api/rsvp/short-link) and opens the invitation as usual.
//
//  The code: SHORT_CODE_LENGTH (10) characters drawn uniformly from the 62
//  letters and digits by crypto.randomInt, about 59.5 bits: unguessable at
//  the rate the lookup allows (rate-limit.middleware.ts's shortLink
//  limiters). Unique (Invite_shortCode_key). Created the first time a text
//  needs it (ensure), never changed or cleared afterwards, and invites are
//  never hard-deleted, so a code is never reused for another guest.
// ─────────────────────────────────────────

export const SHORT_CODE_LENGTH = 10;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAX_TRIES = 5;

export const generateShortCode = (): string => {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
};

// A string that could be a code at all; anything else is answered as an
// unknown code without a query.
export const isShortCodeShaped = (value: string): boolean => new RegExp(`^[A-Za-z0-9]{${SHORT_CODE_LENGTH}}$`).test(value);

export const shortLinkFor = (code: string): string => frontendUrl(`/r/${code}`);

export const inviteShortCodeService = {
  // The invite's code, created now if it has none. `existing` is the code
  // the caller already read (null if none). Written only where the invite
  // still has none, so two workers racing end with one code, the first;
  // a fresh code that another invite already has (unique index) is drawn
  // again. `generate` is for tests.
  ensure: async (inviteId: string, existing: string | null, generate: () => string = generateShortCode): Promise<string> => {
    if (existing) return existing;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const code = generate();
      try {
        if (await inviteRepository.setShortCodeIfMissing(inviteId, code)) return code;
      } catch (err) {
        if (isUniqueViolationOn(err, 'Invite', 'shortCode')) continue;
        throw err;
      }
      // Not written: it has one already (set by someone else just now).
      const current = await inviteRepository.findShortCode(inviteId);
      if (current) return current;
      throw new Error(`invite ${inviteId} not found for a short code`);
    }
    throw new Error(`no unique short code after ${MAX_TRIES} tries`);
  },
};
