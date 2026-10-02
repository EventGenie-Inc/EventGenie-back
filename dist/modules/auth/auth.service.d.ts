import { type RegisterDto, type VerifyOtpDto, type ExchangeSessionDto, type LogoutDto } from './auth.types.js';
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
        otpExpiresAt: string;
    }>;
    verifyOtp: (firebaseToken: string, data: VerifyOtpDto, userAgent?: string | null) => Promise<{
        sessionToken: string;
        expiresIn: string;
        deviceToken: string;
        deviceTokenExpiresAt: string;
        user: {
            id: string;
            email: string;
            username: string;
            role: import("@prisma/client").$Enums.PlatformRole;
            tenantId: string | null;
        };
    }>;
    exchangeSession: (firebaseToken: string, data: ExchangeSessionDto) => Promise<{
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
    logout: (data: LogoutDto) => Promise<{
        message: string;
    }>;
    refreshSession: (firebaseToken: string, currentSessionToken: string) => Promise<{
        sessionToken: string;
        expiresIn: string;
    }>;
    forgotPassword: (email: string) => Promise<{
        message: string;
    }>;
};
//# sourceMappingURL=auth.service.d.ts.map