import { signCloudinaryParams } from './cloudinary-signature.util.js';

// ─────────────────────────────────────────
//  CLOUDINARY CLIENT
//
//  Knows Cloudinary and nothing else — no Event/Tenant/tier concepts,
//  no upload "purpose" logic. Same separation as sms.engine.ts /
//  here.client.ts. Signature *generation* for uploads lives in
//  upload.service.ts (that's where the purpose-specific constraints —
//  folder, formats — are decided); this file only knows how to talk to
//  Cloudinary's API once told what to sign, plus the one operation
//  callers need directly: deleting assets by id, one or a batch.
// ─────────────────────────────────────────

interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export const requireCloudinaryConfig = (): CloudinaryConfig => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET are not fully defined in .env');
  }

  return { cloudName, apiKey, apiSecret };
};

export interface DestroyResult {
  ok: boolean;
  reason?: string;
}

// Signed `destroy` call (part of the Upload API, not the Basic-Auth Admin
// API) — same signing mechanism as an upload, just with {public_id,
// timestamp} as the signed params. Used for: replacing a cover image
// (delete the old asset) and rejecting an oversized upload (delete what
// was already stored before Cloudinary ever finished telling us how big
// it was). Never throws — a failed delete is a harmless orphan, not a
// reason to fail the caller's actual operation.
export const destroyAsset = async (publicId: string, resourceType: 'image' | 'video' = 'image'): Promise<DestroyResult> => {
  let config: CloudinaryConfig;
  try {
    config = requireCloudinaryConfig();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Uploads aren't available right now." };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signCloudinaryParams({ public_id: publicId, timestamp }, config.apiSecret);

  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: config.apiKey,
    signature,
  });

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const json = await res.json() as { result?: string };
    // Cloudinary reports a missing asset as result:"not found" with a 200 —
    // treated as success here since the end state (asset gone) is what
    // callers actually care about, whether it was deleted just now or
    // already gone.
    if (!res.ok || (json.result !== 'ok' && json.result !== 'not found')) {
      return { ok: false, reason: json.result ?? `HTTP ${res.status}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
};

// Cloudinary's Admin API deletes at most 100 assets per call.
export const CLOUDINARY_DELETE_BATCH_LIMIT = 100;
const DELETE_BATCH_TIMEOUT_MS = 30_000;

export type DestroyAssetsResult =
  // deleted: every id now gone ("deleted", or "not_found": already gone).
  // failed: every other id, with Cloudinary's word for it.
  | { ok: true; deleted: string[]; failed: { publicId: string; reason: string }[] }
  // The whole call failed: nothing is known to be deleted.
  | { ok: false; reason: string };

// Deletes up to CLOUDINARY_DELETE_BATCH_LIMIT assets of one resource type in
// one call: the Admin API's "delete resources" (Basic auth with the API key
// and secret, unlike destroyAsset's signed Upload API call). `invalidate`
// also clears the CDN's cached copies, so a deleted photo stops loading
// from a URL someone kept. Never throws. An id missing from Cloudinary's
// answer counts as failed, so it is tried again rather than assumed gone.
// Used by the archived-event media purge (media-retention.service.ts), whose
// ids are all checked against the event's own folder first.
export const destroyAssets = async (publicIds: string[], resourceType: 'image' | 'video' = 'image'): Promise<DestroyAssetsResult> => {
  if (publicIds.length === 0) return { ok: true, deleted: [], failed: [] };
  if (publicIds.length > CLOUDINARY_DELETE_BATCH_LIMIT) {
    return { ok: false, reason: `At most ${CLOUDINARY_DELETE_BATCH_LIMIT} assets per call` };
  }

  let config: CloudinaryConfig;
  try {
    config = requireCloudinaryConfig();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Uploads aren't available right now." };
  }

  const query = [
    ...publicIds.map((id) => `${encodeURIComponent('public_ids[]')}=${encodeURIComponent(id)}`),
    'invalidate=true',
  ].join('&');
  const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/${resourceType}/upload?${query}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(DELETE_BATCH_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { deleted?: Record<string, string>; error?: { message?: string } };
    if (!res.ok || !json.deleted) {
      return { ok: false, reason: json.error?.message ?? `HTTP ${res.status}` };
    }

    const deleted: string[] = [];
    const failed: { publicId: string; reason: string }[] = [];
    for (const publicId of publicIds) {
      const outcome = json.deleted[publicId];
      if (outcome === 'deleted' || outcome === 'not_found') deleted.push(publicId);
      else failed.push({ publicId, reason: outcome ?? 'missing from the response' });
    }
    return { ok: true, deleted, failed };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
};
