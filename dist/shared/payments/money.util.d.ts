import { Prisma } from '@prisma/client';
export declare const DEFAULT_CURRENCY = "ZAR";
export declare const decimalToCents: (amount: Prisma.Decimal | number | string) => number;
export declare const centsToDecimalString: (cents: number) => string;
export declare const applyBasisPoints: (amountCents: number, basisPoints: number) => number;
export declare const grossUpForFeeRate: (amountToPreserveCents: number, feePpm: number) => number;
//# sourceMappingURL=money.util.d.ts.map