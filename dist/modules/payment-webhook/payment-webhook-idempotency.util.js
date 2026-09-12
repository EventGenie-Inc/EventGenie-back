import { Prisma } from '@prisma/client';
// Translates the raw unique-constraint violation on
// PaystackWebhookEvent.dedupeKey into "this delivery has already been
// processed" — same shape as event-day-validation.util.ts's
// isDayLabelUniqueViolation. The DB constraint is what actually
// prevents double-processing (structural, not check-then-write); this
// predicate just lets the service tell that specific failure apart from
// any other error the transaction could throw.
export const isDuplicateWebhookEvent = (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
//# sourceMappingURL=payment-webhook-idempotency.util.js.map