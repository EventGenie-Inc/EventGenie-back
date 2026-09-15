import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
export const paymentWebhookRepository = {
    // The unique constraint on dedupeKey (schema.prisma) is the actual
    // idempotency enforcement — this insert either succeeds (first time
    // seeing this delivery) or throws P2002 (seen it before). There is no
    // findFirst-then-create here on purpose: that would race two
    // concurrent deliveries of the same retry straight through the check.
    markProcessed: (eventType, dedupeKey, db = prisma) => db.paystackWebhookEvent.create({ data: { eventType, dedupeKey } }),
};
//# sourceMappingURL=payment-webhook.repository.js.map