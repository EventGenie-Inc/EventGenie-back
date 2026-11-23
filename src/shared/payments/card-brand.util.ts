// ─────────────────────────────────────────
//  A CARD'S BRAND, FOR DISPLAY (fix/payments-go-live)
//
//  Paystack's authorization.card_type arrives padded and lower case ("visa ",
//  seen on dev on 22 Nov 2026). Trimmed, and each word capitalised: "Visa",
//  "Mastercard", "American Express". Empty is null. Applied wherever the
//  brand is stored (subscription.repository.ts) and again when it is
//  returned (GET /api/subscriptions' card), so a row stored before this fix
//  reads correctly with no migration. Idempotent.
// ─────────────────────────────────────────
export const displayCardBrand = (raw: string | null | undefined): string | null => {
  if (typeof raw !== 'string') return null;
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
};
