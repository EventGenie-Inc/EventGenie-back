import { type EventPassTier } from '@prisma/client';

export interface PurchaseEventPassDto {
  passTier: EventPassTier;
}

export interface PurchaseSmsBundleDto {
  smsCount: number;
}

export type PassCheckoutResult = { authorizationUrl: string };

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
