// MEMORY_ITEM included from the start (Batch C reuses this endpoint)
// but not implemented yet — requestSignature() rejects it explicitly
// rather than silently applying EVENT_COVER's constraints to it.
export type UploadPurpose = 'EVENT_COVER' | 'MEMORY_ITEM';

export interface RequestUploadSignatureDto {
  purpose: UploadPurpose;
  eventId?: string;
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
