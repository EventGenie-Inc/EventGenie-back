import { type Request } from 'express';
import { type PlatformRole } from '@prisma/client';

// ─────────────────────────────────────────
//  Authenticated Request
//  Available in all protected routes after
//  the authenticate middleware runs.
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
//  Standard API Response
// ─────────────────────────────────────────
export interface ApiResponse<T> {
  status: 'ok' | 'error';
  data?: T;
  message?: string;
}