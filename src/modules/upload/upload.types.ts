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
}
