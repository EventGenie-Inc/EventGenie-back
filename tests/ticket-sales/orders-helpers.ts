import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { fakePaystack } from '../helpers/fake-paystack.js';
import { sendWebhook } from '../helpers/paystack-webhook.js';
import { createOrg, createTicketedEvent, createType, givePayoutAccount, setSales, prisma, type Org, type TicketedEvent } from './helpers.js';

// ─────────────────────────────────────────
//  Ticket sales Round B fixtures: an event selling tickets (Elevate, a
//  payout account, types, sales switched on), a checkout through the public
//  route, and paying it through the fake Paystack and the signed webhook.
// ─────────────────────────────────────────

export interface Selling {
  org: Org;
  ev: TicketedEvent;
  subaccountCode: string;
  general: string; // R200, 100 of them, every day
  saturday: string; // R150, 5 of them, Day 2 only
}

export const sellingEvent = async (opts: { generalQuantity?: number; saturdayQuantity?: number } = {}): Promise<Selling> => {
  const org = await createOrg();
  const tenant = await givePayoutAccount(org.tenantId);
  const ev = await createTicketedEvent(org);
  const general = await createType(org.admin, ev.eventId, { name: 'General', priceCents: 20_000, quantity: opts.generalQuantity ?? 100 });
  const saturday = await createType(org.admin, ev.eventId, { name: 'Saturday', priceCents: 15_000, quantity: opts.saturdayQuantity ?? 5, admittedDayIds: [ev.dayIds[1]] });
  if (general.status !== 201 || saturday.status !== 201) throw new Error('fixture types not created');
  const on = await setSales(org.admin, ev.eventId, { enabled: true });
  if (on.status !== 200) throw new Error(`sales not switched on: ${JSON.stringify(on.body)}`);
  return { org, ev, subaccountCode: tenant.paystackSubaccountCode!, general: general.body.data.id, saturday: saturday.body.data.id };
};

let ipCounter = 0;
const freshIp = () => {
  ipCounter += 1;
  return `10.77.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

export const buyerEmail = () => `buyer-${randomUUID()}@test.invalid`;

export const checkout = (
  s: { ev: TicketedEvent },
  items: { ticketTypeId: string; quantity: number }[],
  overrides: Record<string, unknown> = {}
) =>
  request(app)
    .post('/api/ticket-orders/checkout')
    .set('X-Forwarded-For', freshIp())
    .send({
      shareToken: s.ev.shareToken,
      items,
      buyer: { name: 'Thandi Nkosi', email: buyerEmail(), phone: '082 123 4567' },
      termsAccepted: true,
      idempotencyKey: `key-${randomUUID()}`,
      ...overrides,
    });

export const orderStatus = (token: string, refresh = false) =>
  request(app).post('/api/ticket-orders/status').set('X-Forwarded-For', freshIp()).send({ token, ...(refresh && { refresh: true }) });

export const referencesOf = async (orderId: string): Promise<string[]> =>
  (await prisma.ticketOrderPayment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((p) => p.reference);

export const latestReference = async (orderId: string): Promise<string> => (await referencesOf(orderId)).at(-1)!;

// The payer completes Paystack's checkout; the signed webhook arrives.
export const pay = async (reference: string, overrides: Parameters<typeof fakePaystack.pay>[1] = {}) => {
  const data = fakePaystack.pay(reference, overrides);
  const res = await sendWebhook('charge.success', data);
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
  return data;
};

// Checkout and pay in one: the order's id, token and tickets.
export const buyAndPay = async (s: Selling, items: { ticketTypeId: string; quantity: number }[]) => {
  const res = await checkout(s, items);
  if (res.status !== 201) throw new Error(`checkout answered ${res.status}: ${JSON.stringify(res.body)}`);
  const orderId = res.body.data.orderId as string;
  await pay(await latestReference(orderId));
  const tickets = await prisma.issuedTicket.findMany({ where: { orderId }, orderBy: { indexInOrder: 'asc' } });
  return { orderId, token: res.body.data.orderToken as string, tickets };
};

export { prisma, fakePaystack, sendWebhook };
