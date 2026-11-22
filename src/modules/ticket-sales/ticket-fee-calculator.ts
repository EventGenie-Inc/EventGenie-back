import { getTicketFeeConfig, type TicketFeeConfig } from '../../shared/payments/payments.config.js';
import { applyBasisPoints } from '../../shared/payments/money.util.js';

// ─────────────────────────────────────────
//  THE TICKET FEE CALCULATOR (ticket sales Round A)
//
//  One pure function, used for every ticket price anyone sees or pays: the
//  public page's all-in price, and (Round B) the checkout's amount and its
//  split. Integer cents in, integer cents out.
//
//  Split at source: the organiser receives exactly the ticket subtotal.
//  e-velope keeps its commission (PLATFORM_COMMISSION_PERCENT of the
//  subtotal) and its fixed fee per order (PLATFORM_TICKET_FIXED_FEE_CENTS).
//  The guest pays those and Paystack's fee on top, through a gross-up of
//  the ORDER as a whole, so Paystack's flat fee is charged once per payment,
//  never once per ticket.
//
//  The gross-up: the smallest total T (whole cents) such that
//      T − paystackFee(T) ≥ subtotal + commission + fixed fee
//  where paystackFee(T) = (T × rate + flat) × (1 + VAT), rounded UP to the
//  cent (we assume Paystack rounds its fee the way that costs us most).
//
//  Rounding, stated:
//  - commission: subtotal × rate, half up (applyBasisPoints);
//  - total: up to the next cent, and then up again while the fee rounded up
//    would leave less than the target, so e-velope is never short;
//  - the organiser's share is the subtotal exactly, always: Round B sends
//    Paystack `transaction_charge` = total − subtotal with `bearer:
//    "account"` (Paystack's fee taken from e-velope's side), so every cent
//    of rounding lands on e-velope's side, never the organiser's.
//  `processingFeeCents` is what is left for Paystack: total − subtotal −
//  commission − fixed fee (its estimated fee, plus at most a cent or two of
//  rounding, which e-velope keeps if Paystack takes less).
//
//  Priced at the local card rate. Paystack fixes the amount before the
//  guest picks a channel, and its other South African channels (EFT,
//  Capitec Pay: 2%, no flat fee) cost less, so e-velope is never short.
//  Paystack waives the R1 on payments under R10; a ticket can't be under
//  R10 (MIN_TICKET_PRICE_CENTS), so that never applies.
// ─────────────────────────────────────────

export interface TicketOrderInput {
  unitPriceCents: number;
  quantity: number;
}

export interface TicketOrderFees {
  unitPriceCents: number;
  quantity: number;
  // The tickets' own price: unitPriceCents × quantity.
  subtotalCents: number;
  // e-velope's commission on the subtotal.
  commissionCents: number;
  // e-velope's fixed fee for the order.
  platformFixedFeeCents: number;
  // For Paystack's fee (see above).
  processingFeeCents: number;
  // What the guest pays: the Paystack amount.
  totalCents: number;
  // What the organiser receives: always exactly subtotalCents.
  organiserShareCents: number;
  // e-velope's transaction charge at Paystack: totalCents − subtotalCents
  // (commission + fixed fee + processing).
  transactionChargeCents: number;
}

const isWholeCents = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

// Paystack's fee on a payment of `total` cents, rounded up to the cent.
const paystackFeeCents = (total: bigint, c: TicketFeeConfig): bigint => {
  // (total × bp/10⁴ + flat) × (10⁴ + vat)/10⁴, exactly, over 10⁸.
  const numerator = (total * BigInt(c.paystackFeeBasisPoints) + BigInt(c.paystackFlatFeeCents) * 10_000n) * BigInt(10_000 + c.paystackVatBasisPoints);
  return ceilDiv(numerator, 100_000_000n);
};

export const calculateTicketOrderFees = (input: TicketOrderInput, config: TicketFeeConfig = getTicketFeeConfig()): TicketOrderFees => {
  const { unitPriceCents, quantity } = input;
  if (!isWholeCents(unitPriceCents)) throw new Error(`unitPriceCents must be a whole number of cents (got ${unitPriceCents})`);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`quantity must be a whole number of 1 or more (got ${quantity})`);

  const subtotalCents = unitPriceCents * quantity;
  const commissionCents = applyBasisPoints(subtotalCents, config.commissionBasisPoints);
  const platformFixedFeeCents = config.platformFixedFeeCents;
  const target = BigInt(subtotalCents + commissionCents + platformFixedFeeCents);

  // T × (10⁸ − bp × (10⁴ + vat)) ≥ target × 10⁸ + flat × 10⁴ × (10⁴ + vat)
  const vatFactor = BigInt(10_000 + config.paystackVatBasisPoints);
  const keptPerUnit = 100_000_000n - BigInt(config.paystackFeeBasisPoints) * vatFactor;
  let total = ceilDiv(target * 100_000_000n + BigInt(config.paystackFlatFeeCents) * 10_000n * vatFactor, keptPerUnit);
  // The fee rounded up can still take one cent too many: step up until not.
  while (total - paystackFeeCents(total, config) < target) total += 1n;

  const totalCents = Number(total);
  return {
    unitPriceCents,
    quantity,
    subtotalCents,
    commissionCents,
    platformFixedFeeCents,
    processingFeeCents: totalCents - subtotalCents - commissionCents - platformFixedFeeCents,
    totalCents,
    organiserShareCents: subtotalCents,
    transactionChargeCents: totalCents - subtotalCents,
  };
};
