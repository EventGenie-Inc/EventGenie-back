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
//  callers need directly: deleting an asset by id.
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
    return { ok: false, reason: error instanceof Error ? error.message : 'Cloudinary is not configured' };
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
