import { Router } from 'express';
import { paymentWebhookService } from './payment-webhook.service.js';
import {} from './payment-webhook.types.js';
const router = Router();
// Public and unauthenticated — Paystack calls this directly, so there is
// no `authenticate` middleware on this route at all. The HMAC signature
// check below IS the authentication for this endpoint.
router.post('/', async (req, res) => {
    const signatureHeader = req.headers['x-paystack-signature'];
    const rawBody = req.rawBody;
    // Missing rawBody only happens if express.json()'s verify callback
    // never ran (a non-JSON content-type) — Paystack always sends JSON,
    // so this is treated exactly like a bad signature.
    if (!rawBody || !paymentWebhookService.isValidSignature(rawBody, signatureHeader)) {
        // The ONLY thing that happens on an invalid signature: a console
        // line and a 401. No database read, no database write, no parsing
        // of the payload's business content beyond this point — an
        // unverified webhook endpoint is an open door for anyone to declare
        // a payment successful.
        console.warn('[payments webhook] rejected — invalid or missing signature');
        res.status(401).json({ status: 'error', message: 'Invalid signature' });
        return;
    }
    try {
        // Only now, with the signature confirmed genuine, is the payload
        // (already parsed into req.body by express.json() while it captured
        // the same raw bytes checked above) treated as trustworthy.
        const outcome = await paymentWebhookService.process(req.body);
        // Fast, minimal synchronous work only (two indexed inserts in one
        // transaction) — Paystack treats a slow or failing response as a
        // delivery failure and retries harder, so this returns as soon as
        // that work is done rather than deferring it.
        res.status(200).json({ status: 'ok', outcome });
    }
    catch (err) {
        // An unexpected failure AFTER the signature was confirmed genuine
        // (e.g. the database is briefly unreachable) — not a duplicate
        // (paymentWebhookService.process handles that itself and never
        // throws for it) and not a signature problem. A 500 here is
        // deliberate: it tells Paystack to retry, which is exactly what we
        // want once whatever failed has recovered.
        console.error('[payments webhook] processing failed:', err);
        res.status(500).json({ status: 'error', message: 'Webhook processing failed' });
    }
});
export default router;
//# sourceMappingURL=payment-webhook.router.js.map