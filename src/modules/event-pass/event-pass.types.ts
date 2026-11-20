import { type EventPassTier } from '@prisma/client';

export interface PurchaseEventPassDto {
  passTier: EventPassTier;
}

export interface PurchaseSmsBundleDto {
  smsCount: number;
}

// Payments release 1: `purchaseId` (for the callback page's reconcile) and
// `reused` (true when a pending checkout for the same choice was handed
// back instead of a new one being started).
export type PassCheckoutResult = { authorizationUrl: string; purchaseId: string; reused: boolean };

export interface EventPassStatusDto {
  pass: { passTier: EventPassTier; grantedTier: string; purchasedAt: Date } | null;
  isActive: boolean;
  expiresAt: Date | null;
  purchases: {
    id: string;
    passTier: EventPassTier;
    isUpgrade: boolean;
    amountPaidCents: number;
    status: string;
    purchasedAt: Date;
    confirmedAt: Date | null;
  }[];
}

export interface SmsBundleStatusDto {
  purchasedTotal: number;
  usedFromBundle: number;
  remaining: number;
  purchases: {
    id: string;
    smsCount: number;
    amountPaidCents: number;
    status: string;
    purchasedAt: Date;
    confirmedAt: Date | null;
  }[];
}

export interface EventPassPurchaseSignalDto {
  passedEventCount: number;
  isRepeatBuyer: boolean;
}
