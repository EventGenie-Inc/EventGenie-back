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
//# sourceMappingURL=upload.types.d.ts.map