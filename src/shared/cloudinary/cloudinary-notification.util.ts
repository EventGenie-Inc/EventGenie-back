import crypto from 'crypto';
import { requireCloudinaryConfig } from './cloudinary.client.js';

// ─────────────────────────────────────────
//  CLOUDINARY NOTIFICATION SIGNATURES
//
//  A notification (the webhook Cloudinary calls when an upload signed with
//  a notification_url finishes) carries X-Cld-Signature and
//  X-Cld-Timestamp. The signature is a hex digest of the raw body, then the
//  timestamp, then the API secret, with no separators, using SHA-1 or
//  SHA-256 (Cloudinary accepts either, so both are tried). Cloudinary's
//  docs ask for the timestamp to be checked too: older than 2 hours is
//  refused, so a captured notification can't be replayed later.
//  (cloudinary.com/documentation/notification_signatures)
// ─────────────────────────────────────────

export const NOTIFICATION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const safeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export const signNotification = (rawBody: string, timestamp: string, algorithm: 'sha1' | 'sha256' = 'sha1'): string =>
  crypto.createHash(algorithm).update(rawBody + timestamp + requireCloudinaryConfig().apiSecret).digest('hex');

export const isNotificationSignatureValid = (
  rawBody: string,
  signature: unknown,
  timestamp: unknown,
  now: Date = new Date()
): boolean => {
  if (typeof signature !== 'string' || typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return false;
  const ageMs = now.getTime() - Number(timestamp) * 1000;
  if (ageMs > NOTIFICATION_MAX_AGE_MS || ageMs < -5 * 60 * 1000) return false;
  const given = signature.toLowerCase();
  return safeEqualHex(given, signNotification(rawBody, timestamp, 'sha1')) || safeEqualHex(given, signNotification(rawBody, timestamp, 'sha256'));
};
