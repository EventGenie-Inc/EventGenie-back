export interface RegisterDto {
  username: string;
  tenantName: string;
  tenantSlug: string;
}

export interface VerifyOtpDto {
  otp: string;
}

export interface ForgotPasswordDto {
  email: string;
}

// Firebase ID token (Authorization header, same as every other auth
// route) plus the device token proving this device already passed an
// OTP — see device-token.util.ts. Neither alone is enough; see
// auth.service.ts's exchangeSession.
export interface ExchangeSessionDto {
  deviceToken: string;
}

export interface LogoutDto {
  deviceToken: string;
}

export interface AuthUserResponse {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
    tenantId: string | null;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
    subscriptionTier: string;
  } | null;
}

export interface SessionTokenPayload {
  userId: string;
  firebaseUid: string;
  email: string;
  role: string;
  tenantId: string | null;
}