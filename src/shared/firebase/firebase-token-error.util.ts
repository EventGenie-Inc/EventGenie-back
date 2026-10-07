import { HttpError } from '../errors/http-error.js';

// The Firebase Admin error codes that mean "this ID token is no good" —
// expired, revoked, malformed, or signed wrongly — as opposed to Firebase
// itself failing (a network error, an outage), which stays a 500. Firebase
// puts the reason in `.code`, never in `.message`. The same list
// exchangeSession and refreshSession already map by hand (auth.service.ts),
// plus auth/invalid-id-token, which some token faults surface as.
const TOKEN_REJECTION_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/invalid-id-token',
]);

export const isFirebaseTokenRejection = (err: unknown): boolean =>
  typeof (err as { code?: unknown })?.code === 'string' && TOKEN_REJECTION_CODES.has((err as { code: string }).code);

// Awaits a Firebase verification, turning a rejected token into a 401 with
// the given message (never the global handler's 500). Any other failure is
// rethrown unchanged.
export const verifyOr401 = async <T>(verify: () => Promise<T>, message: string): Promise<T> => {
  try {
    return await verify();
  } catch (err) {
    if (isFirebaseTokenRejection(err)) throw new HttpError(401, message);
    throw err;
  }
};
