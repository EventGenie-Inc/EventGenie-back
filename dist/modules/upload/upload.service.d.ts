import { type PlatformRole } from '@prisma/client';
import { type RequestUploadSignatureDto, type UploadSignatureResponse } from './upload.types.js';
export declare const uploadService: {
    requestSignature: (requestingRole: PlatformRole, requestingTenantId: string | null, data: RequestUploadSignatureDto) => Promise<UploadSignatureResponse>;
};
//# sourceMappingURL=upload.service.d.ts.map