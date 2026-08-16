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