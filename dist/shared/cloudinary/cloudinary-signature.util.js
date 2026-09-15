import crypto from 'crypto';
// ─────────────────────────────────────────
//  CLOUDINARY SIGNATURE
//
//  Implements Cloudinary's documented signing algorithm directly with
//  Node's built-in crypto rather than pulling in the `cloudinary` SDK
//  for one hash operation — same minimal-footprint approach as
//  here.client.ts (native fetch over axios). Verified against
//  Cloudinary's current docs (authentication_signatures):
//
//  1. name=value pairs for every param EXCEPT file, cloud_name,
//     resource_type, api_key, and signature itself
//  2. sorted alphabetically by key
//  3. joined with '&'
//  4. api_secret appended directly, no separator
//  5. SHA-1 hex digest of the result
//
//  Whatever is passed in `params` here IS the constraint — Cloudinary
//  recomputes this same signature server-side from what it actually
//  received and rejects a mismatch, so a client cannot alter a signed
//  param without invalidating the signature.
// ─────────────────────────────────────────
export const signCloudinaryParams = (params, apiSecret) => {
    const toSign = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');
    return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
};
//# sourceMappingURL=cloudinary-signature.util.js.map