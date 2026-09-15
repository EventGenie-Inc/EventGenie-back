import { applyBasisPoints, grossUpForFeeRate } from '../../shared/payments/money.util.js';
import { getPlatformCommissionBasisPoints } from '../../shared/payments/payments.config.js';
// ─────────────────────────────────────────
//  PAYSTACK ZAR FEE SCHEDULE
//
//  Published rates as of the Ticketing & Payments batch (per
//  support.paystack.com/en/articles/2130306 — Paystack's own pricing
//  support article, South Africa section): local card 2.9% + R1.00
//  (VAT exclusive); EFT/Capitec Pay 2%, no flat fee. VAT is South
//  Africa's standard 15%, added on top of the quoted "VAT exclusive"
//  rate — i.e. Paystack's actual deduction is (2.9%*T + R1.00) * 1.15.
//
//  THIS IS A PUBLISHED STANDARD RATE, NOT NECESSARILY THIS TENANT'S
//  ACTUAL RATE. Paystack can and does negotiate volume-tier pricing per
//  merchant, and a fee-schedule change on Paystack's side won't show up
//  here automatically. Reconcile against the live Paystack dashboard
//  periodically — a single, named constant here is what makes that a
//  one-line fix instead of a hunt through formula code.
//
//  Only the CARD rate is used below, deliberately — see
//  computeGuestChargeCents's own comment for why.
// ─────────────────────────────────────────
const PAYSTACK_ZAR_CARD_FEE_BASIS_POINTS = 290; // 2.90%
const PAYSTACK_ZAR_CARD_FLAT_FEE_CENTS = 100; // R1.00
const SOUTH_AFRICA_VAT_BASIS_POINTS = 1500; // 15%
// Fee rate and flat fee, VAT-inclusive, in parts-per-million / cents —
// computed once via exact integer arithmetic (basis-point * basis-point
// division stays exact here: 290*100=29000ppm, 29000*11500/10000=33350,
// which divides evenly; the flat fee's 100*11500/10000=115 likewise
// divides evenly). See money.util.ts's grossUpForFeeRate for why ppm
// precision (not basis points) is needed for a VAT-compounded rate.
const EFFECTIVE_CARD_FEE_PPM = Math.round((PAYSTACK_ZAR_CARD_FEE_BASIS_POINTS * 100 * (10_000 + SOUTH_AFRICA_VAT_BASIS_POINTS)) / 10_000);
const EFFECTIVE_CARD_FLAT_FEE_CENTS = Math.round((PAYSTACK_ZAR_CARD_FLAT_FEE_CENTS * (10_000 + SOUTH_AFRICA_VAT_BASIS_POINTS)) / 10_000);
// ─────────────────────────────────────────
//  THE GROSS-UP
//
//  Solves for the total T the guest must pay so that, after EventGenie's
//  commission AND Paystack's own percentage-plus-flat fee are both
//  deducted from T, the organiser still nets exactly the ticket price.
//  See money.util.ts's grossUpForFeeRate for the algebra
//  (T = (ticketPrice + commission + flatFee) / (1 - feeRate)).
//
//  Deliberately priced using the CARD rate even when EFT is also
//  offered as a channel: Paystack's `amount` is fixed at Initialize
//  Transaction time, BEFORE the guest has picked a channel on Paystack's
//  hosted checkout page — there is no way to charge a different total
//  depending on a choice the guest hasn't made yet. Card's rate
//  (2.9%+R1, VAT-inclusive) is higher than EFT's (2%, no flat fee), so
//  pricing off it guarantees the platform is never short — an EFT
//  payment nets EventGenie a little MORE than the target 2.5%, never
//  less. That asymmetry is deliberate: per the payments foundation's own
//  rule, undercollecting a fee is an unrecoverable loss on every ticket,
//  while a small, consistent surplus on EFT payments is not a problem
//  worth solving.
// ─────────────────────────────────────────
export const computeTicketChargeCents = (ticketPriceCents, quantity) => {
    const totalTicketPriceCents = ticketPriceCents * quantity;
    const commissionCents = applyBasisPoints(totalTicketPriceCents, getPlatformCommissionBasisPoints());
    const amountToRecoverCents = totalTicketPriceCents + commissionCents + EFFECTIVE_CARD_FLAT_FEE_CENTS;
    const totalChargeCents = grossUpForFeeRate(amountToRecoverCents, EFFECTIVE_CARD_FEE_PPM);
    const platformChargeCents = totalChargeCents - totalTicketPriceCents;
    return {
        ticketPriceCents: totalTicketPriceCents,
        commissionCents,
        totalChargeCents,
        platformChargeCents,
    };
};
//# sourceMappingURL=ticket-purchase-pricing.util.js.map