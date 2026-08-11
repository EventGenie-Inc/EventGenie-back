import { type Request } from 'express';
import { type PlatformRole } from '@prisma/client';
export interface AuthenticatedRequest extends Request {
    user: {
        id: string;
        firebaseUid: string;
        email: string;
        role: PlatformRole;
        tenantId: string | null;
        vendorSpaceId: string | null;
    };
}
export interface ApiResponse<T> {
    status: 'ok' | 'error';
    data?: T;
    message?: string;
}
//# sourceMappingURL=common.types.d.ts.map