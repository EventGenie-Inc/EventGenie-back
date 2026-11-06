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

export type CloudinaryResourceType = 'image' | 'video' | 'raw';
export type CloudinaryDeliveryType = 'upload' | 'private';

const UPLOAD_API_TIMEOUT_MS = 30_000;

// Signed `destroy` call (part of the Upload API, not the Basic-Auth Admin
// API): one asset, by exact public id. The storage worker's only way of
// deleting (storage-deletion.worker.ts), because the Upload API is not
// rate-limited (Cloudinary's Admin API is: 500 calls an hour on the free
// plan) and its `invalidate` works on every plan (the Admin API's bulk
// delete needs a support request to honour it). `invalidate` clears the
// CDN's cached copies, so a deleted photo stops loading from a URL
// someone kept. Never throws. Cloudinary answers a missing asset with
// result "not found", which counts as done: the asset is gone either way.
export const destroyAsset = async (
  publicId: string,
  resourceType: CloudinaryResourceType = 'image',
  { type = 'upload', invalidate = false }: { type?: CloudinaryDeliveryType; invalidate?: boolean } = {}
): Promise<DestroyResult> => {
  let config: CloudinaryConfig;
  try {
    config = requireCloudinaryConfig();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Uploads aren't available right now." };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signed: Record<string, string | number> = { public_id: publicId, timestamp, type };
  if (invalidate) signed.invalidate = 'true';
  const signature = signCloudinaryParams(signed, config.apiSecret);

  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, String(v)])),
    api_key: config.apiKey,
    signature,
  });

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(UPLOAD_API_TIMEOUT_MS),
    });

    const json = (await res.json().catch(() => ({}))) as { result?: string };
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
// `type` is the delivery type the assets were stored with: 'upload' for
// every public asset, 'private' for guest documents (uploadPrivateRawAsset).
export const destroyAssets = async (
  publicIds: string[],
  resourceType: 'image' | 'video' | 'raw' = 'image',
  type: 'upload' | 'private' = 'upload'
): Promise<DestroyAssetsResult> => {
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
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/${resourceType}/${type}?${query}`, {
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

// ─────────────────────────────────────────
//  MEASURING AN UPLOAD — what Cloudinary actually holds
//
//  The browser reports a file's size after uploading it, and that report
//  is never trusted (anyone can send bytes: 1 for a 100 MB video). The
//  real size comes from Cloudinary: its signed upload notification when
//  one has arrived (storage.router.ts), else this. `explicit` is an Upload
//  API method (signed with the secret, not rate-limited, unlike the Admin
//  API's per-asset lookup) that, called with no transformations, changes
//  nothing and answers with the asset's details, `bytes` included.
// ─────────────────────────────────────────
export type ExplicitResult =
  | { ok: true; bytes: number; format: string | null; secureUrl: string | null }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; reason: string };

export const explicitResource = async (
  publicId: string,
  resourceType: CloudinaryResourceType,
  type: CloudinaryDeliveryType = 'upload'
): Promise<ExplicitResult> => {
  let config: CloudinaryConfig;
  try {
    config = requireCloudinaryConfig();
  } catch (error) {
    return { ok: false, notFound: false, reason: error instanceof Error ? error.message : 'Cloudinary is not configured' };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = { public_id: publicId, timestamp, type };
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    type,
    api_key: config.apiKey,
    signature: signCloudinaryParams(signed, config.apiSecret),
  });
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/explicit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(UPLOAD_API_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { bytes?: number; format?: string; secure_url?: string; error?: { message?: string } };
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok || typeof json.bytes !== 'number') {
      return { ok: false, notFound: false, reason: json.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, bytes: json.bytes, format: json.format ?? null, secureUrl: json.secure_url ?? null };
  } catch (error) {
    return { ok: false, notFound: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
};

// ─────────────────────────────────────────
//  LISTING — the weekly reconciliation only (storage-reconciliation.service.ts)
//
//  Admin API, GET, read-only: one page (up to 500) of the assets of one
//  resource and delivery type whose public id starts with `prefix`. The
//  Admin API is rate-limited per hour, which a weekly listing is far
//  inside of.
// ─────────────────────────────────────────
export interface ListedResource {
  publicId: string;
  resourceType: CloudinaryResourceType;
  type: CloudinaryDeliveryType;
  bytes: number;
  createdAt: string;
}

export type ListResourcesResult =
  | { ok: true; resources: ListedResource[]; nextCursor: string | null }
  | { ok: false; reason: string };

export const listResources = async (
  resourceType: CloudinaryResourceType,
  type: CloudinaryDeliveryType,
  prefix: string,
  cursor: string | null
): Promise<ListResourcesResult> => {
  let config: CloudinaryConfig;
  try {
    config = requireCloudinaryConfig();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Cloudinary is not configured' };
  }
  const query = new URLSearchParams({ prefix, max_results: '500' });
  if (cursor) query.set('next_cursor', cursor);
  const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/${resourceType}/${type}?${query}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(DELETE_BATCH_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as {
      resources?: { public_id: string; bytes: number; created_at: string }[];
      next_cursor?: string;
      error?: { message?: string };
    };
    if (!res.ok || !Array.isArray(json.resources)) return { ok: false, reason: json.error?.message ?? `HTTP ${res.status}` };
    return {
      ok: true,
      resources: json.resources.map((r) => ({ publicId: r.public_id, resourceType, type, bytes: r.bytes, createdAt: r.created_at })),
      nextCursor: json.next_cursor ?? null,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
};
