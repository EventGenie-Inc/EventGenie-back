import { HttpError } from '../../shared/errors/http-error.js';
import { termsRepository } from './terms.repository.js';
import { type TermsStatus } from './terms.types.js';

// ─────────────────────────────────────────
//  TERMS OF SERVICE
//
//  The version of the Terms every account must have accepted to use the
//  app. Until a user has a TermsAcceptance row for THIS version, every
//  authenticated route answers 403 TERMS_NOT_ACCEPTED except the few that
//  use authenticateAllowingPendingTerms (auth.middleware.ts). Change it
//  whenever the Terms change: everyone, super admins included, is asked to
//  accept again on their next request. Guests (RSVP, registration, Memory
//  Hub) are not accounts and never see this.
// ─────────────────────────────────────────
export const TERMS_VERSION = '2026-11-01';

export const TERMS_NOT_ACCEPTED = 'TERMS_NOT_ACCEPTED';
export const TERMS_NOT_ACCEPTED_MESSAGE = 'Please accept the Terms of Service to continue.';

export const TERMS_VERSION_MISMATCH = 'TERMS_VERSION_MISMATCH';
export const TERMS_VERSION_MISMATCH_MESSAGE =
  'The Terms of Service have been updated since this page loaded. Reload the page to read the current version.';

export const termsService = {
  getStatus: async (userId: string): Promise<TermsStatus> => {
    const [latest, acceptedCurrent] = await Promise.all([
      termsRepository.findLatest(userId),
      termsRepository.hasAccepted(userId, TERMS_VERSION),
    ]);
    return {
      currentVersion: TERMS_VERSION,
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest?.acceptedAt ?? null,
      mustAccept: !acceptedCurrent,
    };
  },

  // Only the current version can be accepted: a page that showed older
  // Terms (open across a version change) must not record acceptance of
  // words the person never saw. Accepting again is harmless and keeps the
  // first acceptance's time.
  accept: async (userId: string, version: unknown): Promise<TermsStatus> => {
    if (typeof version !== 'string') {
      throw new HttpError(400, 'version is required.');
    }
    if (version !== TERMS_VERSION) {
      throw new HttpError(409, TERMS_VERSION_MISMATCH_MESSAGE, TERMS_VERSION_MISMATCH);
    }
    await termsRepository.append(userId, TERMS_VERSION);
    return termsService.getStatus(userId);
  },
};
