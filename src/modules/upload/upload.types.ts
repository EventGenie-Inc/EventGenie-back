export type UploadPurpose = 'EVENT_COVER' | 'MEMORY_ITEM';

export interface RequestUploadSignatureDto {
  purpose: UploadPurpose;
  eventId?: string;
  // Required for MEMORY_ITEM (both image and video allowed there,
  // unlike EVENT_COVER which is always an image) — picks the resource
  // type, allowed formats, and size limit.
  mediaType?: 'IMAGE' | 'VIDEO';
}

export interface UploadSignatureResponse {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  uploadUrl: string;
  folder: string;
  publicId: string;
  allowedFormats: string;
  maxFileSizeBytes: number;
  // Every field to POST to uploadUrl with the file, exactly as given
  // (api_key, timestamp, signature, folder, public_id, allowed_formats, and
  // notification_url when the environment has one). The fields above are
  // the same values, kept for the current frontend.
  params: Record<string, string>;
}
