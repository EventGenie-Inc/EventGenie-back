import { type EventPassTier, type PaymentAttemptStatus } from '@prisma/client';

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

// GET /api/events/:eventId/pass/purchases: every pass and bundle purchase,
// every status (PENDING, PAID, FAILED, REFUNDED, REVERSED, UNDER_REVIEW),
// newest first, whatever the pass or the `sms` flag.
export interface EventPurchasesDto {
  passPurchases: {
    id: string;
    passTier: EventPassTier;
    isUpgrade: boolean;
    amountPaidCents: number;
    currency: string;
    status: PaymentAttemptStatus;
    purchasedAt: Date;
    confirmedAt: Date | null;
  }[];
  smsBundlePurchases: {
    id: string;
    smsCount: number;
    amountPaidCents: number;
    currency: string;
    status: PaymentAttemptStatus;
    purchasedAt: Date;
    confirmedAt: Date | null;
  }[];
}

export interface EventPassPurchaseSignalDto {
  passedEventCount: number;
  isRepeatBuyer: boolean;
}
