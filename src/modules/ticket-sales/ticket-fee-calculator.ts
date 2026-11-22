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
//  Paystack's fee, as Paystack charges it (paystackFeeCents): each part
//  rounded UP to the cent, separately:
//      percent = ⌈T × rate⌉,  fee before VAT = percent + flat,
//      VAT = ⌈fee before VAT × VAT rate⌉,  fee = fee before VAT + VAT.
//  Confirmed by a real test payment: R999.00 by local card was charged
//  R34.48 (⌈R28.971⌉ = R28.98, + R1 = R29.98, + ⌈R4.497⌉ = R4.50), where one
//  rounding of the whole gives R34.47.
//
//  The gross-up: the smallest total T (whole cents) such that
//      T − paystackFee(T) ≥ subtotal + commission + fixed fee.
//  With per-part rounding there is no exact closed form, so it searches
//  upward from the exact real-valued solution, a lower bound (rounding only
//  ever adds to the fee). The result leaves e-velope its target exactly, or
//  at most a cent over; never short.
//
//  Rounding, stated:
//  - commission: subtotal × rate, half up (applyBasisPoints);
//  - Paystack's fee: each part up, as above;
//  - total: the smallest that covers it;
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

// Paystack's fee on a payment of `total` cents, each part rounded up to the
// cent (see above). Exported for tests and Round B's reconciliation.
export const paystackFeeCents = (totalCents: number, c: TicketFeeConfig = getTicketFeeConfig()): number => {
  const total = BigInt(totalCents);
  const percent = ceilDiv(total * BigInt(c.paystackFeeBasisPoints), 10_000n);
  const beforeVat = percent + BigInt(c.paystackFlatFeeCents);
  const vat = ceilDiv(beforeVat * BigInt(c.paystackVatBasisPoints), 10_000n);
  return Number(beforeVat + vat);
};

export const calculateTicketOrderFees = (input: TicketOrderInput, config: TicketFeeConfig = getTicketFeeConfig()): TicketOrderFees => {
  const { unitPriceCents, quantity } = input;
  if (!isWholeCents(unitPriceCents)) throw new Error(`unitPriceCents must be a whole number of cents (got ${unitPriceCents})`);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`quantity must be a whole number of 1 or more (got ${quantity})`);

  const subtotalCents = unitPriceCents * quantity;
  const commissionCents = applyBasisPoints(subtotalCents, config.commissionBasisPoints);
  const platformFixedFeeCents = config.platformFixedFeeCents;
  const target = BigInt(subtotalCents + commissionCents + platformFixedFeeCents);

  // The exact real-valued solution, rounded down: a lower bound, since
  // rounding only adds to the fee. Then upward to the first total that
  // covers the target.
  //   T × (10⁸ − bp × (10⁴ + vat)) = target × 10⁸ + flat × 10⁴ × (10⁴ + vat)
  const vatFactor = BigInt(10_000 + config.paystackVatBasisPoints);
  const keptPerUnit = 100_000_000n - BigInt(config.paystackFeeBasisPoints) * vatFactor;
  let totalCents = Number((target * 100_000_000n + BigInt(config.paystackFlatFeeCents) * 10_000n * vatFactor) / keptPerUnit);
  while (totalCents - paystackFeeCents(totalCents, config) < Number(target)) totalCents += 1;

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
