import { type RegisterDto, type VerifyOtpDto } from './auth.types.js';
export declare const authService: {
    register: (firebaseToken: string, data: RegisterDto) => Promise<{
        user: {
            id: string;
            email: string;
            username: string;
            role: import("@prisma/client").$Enums.PlatformRole;
            tenantId: string | null;
        };
        tenant: {
            id: string;
            name: string;
            slug: string;
            subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        };
    }>;
    requestOtp: (firebaseToken: string) => Promise<{
        message: string;
    }>;
    verifyOtp: (firebaseToken: string, data: VerifyOtpDto) => Promise<{
        sessionToken: string;
        expiresIn: string;
        user: {
            id: string;
            email: string;
            username: string;
            role: import("@prisma/client").$Enums.PlatformRole;
            tenantId: string | null;
        };
    }>;
    refreshSession: (firebaseToken: string, currentSessionToken: string) => Promise<{
        sessionToken: string;
        expiresIn: string;
    }>;
};
//# sourceMappingURL=auth.service.d.ts.map