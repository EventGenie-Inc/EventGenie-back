import { requireCloudinaryConfig } from './cloudinary.client.js';
import { signCloudinaryParams } from './cloudinary-signature.util.js';

// ─────────────────────────────────────────
//  CLOUDINARY PRIVATE ASSETS (guest documents)
//
//  A guest's document (a proof of payment can hold bank details) is never
//  at a public URL. This server uploads it itself, as a `raw` asset of
//  delivery type `private`: no delivery URL serves a private original, so
//  the only way to read it is the signed, time-limited `download` endpoint
//  below, the URL the SDKs' private_download_url builds. `raw` because the
//  file is stored byte for byte (no image processing, no format conversion)
//  and CSV and XLSX are raw anyway.
//
//  No SDK, the same as cloudinary-signature.util.ts: every parameter except
//  file, api_key, resource_type and cloud_name is signed.
// ─────────────────────────────────────────

const UPLOAD_TIMEOUT_MS = 30_000;

export type PrivateUploadResult =
  | { ok: true; publicId: string; bytes: number }
  | { ok: false; reason: string };

// Never throws. `reason` is Cloudinary's or the network's words, for the
// server log only; it never names the file.
export const uploadPrivateRawAsset = async (
  publicId: string,
  file: Buffer,
  contentType: string
): Promise<PrivateUploadResult> => {
  let config;
  try {
    config = requireCloudinaryConfig();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Cloudinary is not configured' };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signed = { public_id: publicId, timestamp, type: 'private' };
  const form = new FormData();
  // The blob's own name is never sent: Cloudinary would record it.
  form.append('file', new Blob([new Uint8Array(file)], { type: contentType }), 'document');
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('type', 'private');
  form.append('api_key', config.apiKey);
  form.append('signature', signCloudinaryParams(signed, config.apiSecret));

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/raw/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { public_id?: string; bytes?: number; error?: { message?: string } };
    if (!res.ok || json.public_id !== publicId) {
      return { ok: false, reason: json.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, publicId, bytes: json.bytes ?? file.length };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
};

// A link that downloads one private raw asset as an attachment until
// `expiresAt` (Cloudinary checks it when the download starts). The file is
// named after the public id's last segment, which is why a document's
// public id ends in its safe file name (upload-folders.ts).
export const buildPrivateDownloadUrl = (publicId: string, expiresAt: Date, now: Date = new Date()): string => {
  const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
  const params: Record<string, string | number> = {
    attachment: 'true',
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    public_id: publicId,
    timestamp: Math.floor(now.getTime() / 1000),
    type: 'private',
  };
  const signature = signCloudinaryParams(params, apiSecret);
  const query = [
    ...Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`),
    `api_key=${encodeURIComponent(apiKey)}`,
    `signature=${signature}`,
  ].join('&');
  return `https://api.cloudinary.com/v1_1/${cloudName}/raw/download?${query}`;
};
