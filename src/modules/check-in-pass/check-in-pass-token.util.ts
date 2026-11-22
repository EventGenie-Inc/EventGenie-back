import crypto from 'crypto';
import { type CheckInPassKind } from '@prisma/client';

// ─────────────────────────────────────────
//  THE QR PAYLOAD OF A CHECK-IN PASS
//
//    <prefix>.<passId>.<signature>        e.g. EV1.cm3x…q.Zk9…Q
//
//  A signed string, never a URL: a phone camera that isn't our scanner opens
//  nothing with it. The prefix is a version and the pass's kind (RSVP passes
//  are EV1; a ticket's will have its own), so a code can be told apart
//  without the database. The signature is HMAC-SHA256, with
//  CHECKIN_QR_SECRET, of the prefix, the kind and the pass id, base64url (43
//  characters), and is compared in constant time.
//
//  The payload is never stored: it is rebuilt from the pass id whenever the
//  guest's page asks for it. A copy of the database alone can't make a code
//  that scans, because the secret isn't in it. Never log a payload; the
//  Sentry scrubber masks one wherever it appears (sentry-scrub.ts).
// ─────────────────────────────────────────

export const CHECKIN_QR_SECRET_ENV = 'CHECKIN_QR_SECRET';

// At least 32 characters: `randomBytes(32).toString('base64url')` is 43.
export const CHECKIN_QR_SECRET_MIN_LENGTH = 32;

export const PASS_PAYLOAD_PREFIX: Record<CheckInPassKind, string> = {
  RSVP: 'EV1',
};

const KIND_BY_PREFIX = new Map<string, CheckInPassKind>(
  (Object.entries(PASS_PAYLOAD_PREFIX) as [CheckInPassKind, string][]).map(([kind, prefix]) => [prefix, kind])
);

// A Prisma cuid: lowercase letters and digits.
const PASS_ID_SHAPE = /^[a-z0-9]{20,40}$/;
// SHA-256 in base64url without padding.
const SIGNATURE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// Far longer than any real payload (about 73 characters); anything longer
// is refused before it is split.
const MAX_PAYLOAD_LENGTH = 200;

type Env = Record<string, string | undefined>;

// A deployed server: NODE_ENV=production, or STORAGE_ENV naming staging or
// prod. (STORAGE_ENV=dev is shared by local machines and the dev deployment,
// so the dev deployment is caught by NODE_ENV only.)
const isDeployed = (env: Env): boolean =>
  env['NODE_ENV'] === 'production' || env['STORAGE_ENV'] === 'staging' || env['STORAGE_ENV'] === 'prod';

// Called by server.ts before anything else starts: a deployed server refuses
// to start without a secret (and one that is set must be long enough
// anywhere), so no pass is ever signed with a missing or guessable key.
export const assertCheckInQrSecretConfigured = (env: Env = process.env): void => {
  const secret = env[CHECKIN_QR_SECRET_ENV];
  if (!secret) {
    if (isDeployed(env)) {
      throw new Error(
        `${CHECKIN_QR_SECRET_ENV} is not set. Set a random value of at least ${CHECKIN_QR_SECRET_MIN_LENGTH} characters ` +
          `(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"), a different one per environment.`
      );
    }
    return;
  }
  if (secret.length < CHECKIN_QR_SECRET_MIN_LENGTH) {
    throw new Error(`${CHECKIN_QR_SECRET_ENV} must be at least ${CHECKIN_QR_SECRET_MIN_LENGTH} characters.`);
  }
};

// Local development without a secret: one made up for this process, so
// passes work but their codes stop scanning after a restart. Never on a
// deployed server (refused at startup, and again here).
let processSecret: string | null = null;

const signingSecret = (): string => {
  assertCheckInQrSecretConfigured();
  const configured = process.env[CHECKIN_QR_SECRET_ENV];
  if (configured) return configured;
  if (!processSecret) {
    processSecret = crypto.randomBytes(32).toString('base64url');
    console.warn(`[check-in] ${CHECKIN_QR_SECRET_ENV} is not set: QR codes made now stop working when the server restarts.`);
  }
  return processSecret;
};

const sign = (prefix: string, kind: CheckInPassKind, passId: string): string =>
  crypto.createHmac('sha256', signingSecret()).update(`${prefix}|${kind}|${passId}`).digest('base64url');

export const buildPassPayload = (pass: { id: string; kind: CheckInPassKind }): string => {
  const prefix = PASS_PAYLOAD_PREFIX[pass.kind];
  return `${prefix}.${pass.id}.${sign(prefix, pass.kind, pass.id)}`;
};

export interface VerifiedPayload {
  kind: CheckInPassKind;
  passId: string;
}

// The pass a payload names, if its signature is ours; null for anything
// else (wrong shape, unknown prefix, bad or foreign signature). Says nothing
// about whether the pass exists or is still valid.
export const verifyPassPayload = (payload: unknown): VerifiedPayload | null => {
  if (typeof payload !== 'string') return null;
  const text = payload.trim();
  if (!text || text.length > MAX_PAYLOAD_LENGTH) return null;

  const parts = text.split('.');
  if (parts.length !== 3) return null;
  const [prefix, passId, signature] = parts as [string, string, string];

  const kind = KIND_BY_PREFIX.get(prefix);
  if (!kind || !PASS_ID_SHAPE.test(passId) || !SIGNATURE_SHAPE.test(signature)) return null;

  const expected = Buffer.from(sign(prefix, kind, passId));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { kind, passId };
};
