import crypto from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { webhookDedupeKey } from '../../src/modules/payment-webhook/payment-webhook.service.js';

// Every dedupe key and object id a test's webhooks produced, so the test can
// remove what it made (tests/payments/payments-fixtures.ts).
export const sentWebhookKeys: string[] = [];
export const sentWebhookIds: string[] = [];

// A webhook signed exactly as Paystack signs it (HMAC-SHA512 of the raw
// body with the secret key), through the real route and signature check.
export const sendWebhook = (event: string, data: Record<string, unknown>, options: { signature?: string; rawBody?: string } = {}) => {
  const body = options.rawBody ?? JSON.stringify({ event, data });
  sentWebhookKeys.push(webhookDedupeKey(event, data, body));
  const id = data['id'] ?? data['reference'];
  if (typeof id === 'string' || typeof id === 'number') sentWebhookIds.push(String(id));
  const signature =
    options.signature ?? crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY as string).update(body).digest('hex');
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signature)
    .send(body);
};
