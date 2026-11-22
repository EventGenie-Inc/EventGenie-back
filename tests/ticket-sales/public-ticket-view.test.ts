import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { installFirebaseMock, headersFor } from '../helpers/team.js';
import { view } from '../public-events/helpers.js';
import { buildPublicTicketSales } from '../../src/modules/ticket-sales/ticket-public-view.js';
import { parseSaLocal } from '../../src/modules/reminder-schedule/reminder-schedule-time.util.js';
import {
  cleanupTicketSalesFixtures,
  createOrg,
  createTicketedEvent,
  createType,
  givePayoutAccount,
  setSales,
  simulateSale,
  prisma,
  ACCOUNT_NUMBER,
} from './helpers.js';

// ─────────────────────────────────────────
//  TICKET TYPES ON THE PUBLIC PAGE (ticket sales Round A)
//  GET /api/public-events/:shareToken → ticketSales
//
//  Each visible type on sale: name, description, days, price, the all-in
//  price for one ticket, its fees split, availability and maxPerOrder.
//  Never a hidden type, the payout account, or how many are sold or exist;
//  "only N left" only at 10 or fewer.
// ─────────────────────────────────────────

beforeEach(() => {
  installFirebaseMock();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTicketSalesFixtures();
});

const paidEvent = async () => {
  const org = await createOrg();
  await givePayoutAccount(org.tenantId);
  await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackAccountNumberLast4: ACCOUNT_NUMBER.slice(-4), paystackAccountHolderName: 'Secret Holder Name' } });
  const ev = await createTicketedEvent(org);
  const general = await createType(org.admin, ev.eventId, { name: 'General', description: 'Both days', priceCents: 20_000, quantity: 500, sortOrder: 1 });
  const saturday = await createType(org.admin, ev.eventId, { name: 'Saturday', priceCents: 15_000, quantity: 50, admittedDayIds: [ev.dayIds[1]], maxPerOrder: 4, sortOrder: 2 });
  const hidden = await createType(org.admin, ev.eventId, { name: 'Staff comp', priceCents: 1_000, quantity: 10, status: 'HIDDEN', sortOrder: 3 });
  expect((await setSales(org.admin, ev.eventId, { enabled: true })).status).toBe(200);
  return { org, ev, general: general.body.data.id as string, saturday: saturday.body.data.id as string, hidden: hidden.body.data.id as string };
};

describe('the public ticket list', () => {
  it('shows each visible type with its days, prices and fees, in order', async () => {
    const { ev } = await paidEvent();
    const res = await view(ev.shareToken);
    expect(res.status).toBe(200);
    const sales = res.body.data.ticketSales;
    expect(Object.keys(sales).sort()).toEqual(['paused', 'ticketTypes']);
    expect(sales.paused).toBe(false);
    expect(sales.ticketTypes.map((t: { name: string }) => t.name)).toEqual(['General', 'Saturday']);

    const [general, saturday] = sales.ticketTypes;
    expect(Object.keys(general).sort()).toEqual(
      ['allInPriceCents', 'availability', 'days', 'description', 'fees', 'id', 'maxPerOrder', 'name', 'priceCents', 'remaining', 'salesEnd', 'salesEndLocal', 'salesStart', 'salesStartLocal'].sort()
    );
    // R200: R212.24 all in (Paystack's fee rounded per part); the split adds up.
    expect(general).toMatchObject({
      description: 'Both days',
      priceCents: 20_000,
      allInPriceCents: 21_224,
      fees: { commissionCents: 400, platformFixedFeeCents: 0, processingFeeCents: 824, totalCents: 1_224 },
      availability: 'ON_SALE',
      remaining: null,
      maxPerOrder: 10,
    });
    expect(general.days.map((d: { label: string }) => d.label)).toEqual(['Day 1', 'Day 2']);
    expect(saturday.days.map((d: { label: string }) => d.label)).toEqual(['Day 2']);
    expect(saturday.maxPerOrder).toBe(4);
  }, 60000);

  it('never carries a hidden type, the payout account, or sold and total counts', async () => {
    const { ev, general, hidden } = await paidEvent();
    await simulateSale(general, 123, 4);
    const body = JSON.stringify((await view(ev.shareToken)).body);
    expect(body).not.toContain(hidden);
    expect(body).not.toContain('Staff comp');
    for (const secret of ['ACCT_fixture', 'Fake Bank', ACCOUNT_NUMBER.slice(-4), 'Secret Holder Name', 'subaccount', 'payout']) {
      expect(body).not.toContain(secret);
    }
    const sales = JSON.stringify((await view(ev.shareToken)).body.data.ticketSales);
    for (const key of ['soldCount', 'heldCount', 'quantity', 'totalQuantity', 'hasSales', 'status', 'sortOrder', 'tenantId', 'eventId']) {
      expect(sales).not.toContain(`"${key}"`);
    }
    expect(body).not.toContain('"123"');
    expect(body).not.toMatch(/:123[,}]/);
  }, 60000);

  it('"only N left" appears at 10 or fewer, never above; then sold out', async () => {
    const { ev, saturday } = await paidEvent();
    const remainingOf = async () => (await view(ev.shareToken)).body.data.ticketSales.ticketTypes.find((t: { name: string }) => t.name === 'Saturday');

    await simulateSale(saturday, 39); // 11 left
    expect((await remainingOf()).remaining).toBeNull();
    await simulateSale(saturday, 40); // 10 left
    expect((await remainingOf()).remaining).toBe(10);
    await simulateSale(saturday, 45, 3); // 2 left: checkouts in progress count against it
    expect((await remainingOf()).remaining).toBe(2);
    await simulateSale(saturday, 50);
    expect(await remainingOf()).toMatchObject({ availability: 'SOLD_OUT', remaining: null });
  }, 60000);

  it('not yet on sale, and sales ended', async () => {
    const { org, ev, general, saturday } = await paidEvent();
    await prisma.ticket.update({ where: { id: general }, data: { salesStart: new Date(Date.now() + 7 * 86_400_000) } });
    await prisma.ticket.update({ where: { id: saturday }, data: { salesEnd: new Date(Date.now() - 60_000) } });
    const types = (await view(ev.shareToken)).body.data.ticketSales.ticketTypes;
    expect(types.map((t: { availability: string }) => t.availability)).toEqual(['NOT_YET_ON_SALE', 'SALES_ENDED']);
    void org;
  }, 60000);

  it('a free event, or ticketing switched off, shows no tickets', async () => {
    const { ev } = await paidEvent();
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    expect((await view(ev.shareToken)).body.data.ticketSales).toBeNull();
    vi.unstubAllEnvs();
    await prisma.event.update({ where: { id: ev.eventId }, data: { ticketing: 'FREE' } });
    expect((await view(ev.shareToken)).body.data.ticketSales).toBeNull();
  }, 60000);
});

describe('sales windows are South African time, whatever the server says', () => {
  it('a window ending 23:59 SA is on sale at 23:58 SA and has ended at 00:00 SA', async () => {
    // A server far from South Africa: nothing may depend on its zone.
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(new Date('2027-03-02T12:00:00Z').getTimezoneOffset()).toBe(480);

    const { org, ev, general } = await paidEvent();
    const saved = await request(app)
      .put(`/api/events/${ev.eventId}/tickets/${general}`)
      .set(headersFor(org.admin))
      .send({ salesEnd: '2027-03-02T23:59' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ salesEnd: '2027-03-02T21:59:00.000Z', salesEndLocal: '2027-03-02T23:59' });

    const event = await prisma.event.findUniqueOrThrow({ where: { id: ev.eventId }, include: { eventDays: { where: { isArchived: false } } } });
    const at = async (local: string) =>
      (await buildPublicTicketSales(event, parseSaLocal(local)!)).ticketTypes.find((t) => t.id === general)!;

    expect((await at('2027-03-02T23:58')).availability).toBe('ON_SALE');
    expect((await at('2027-03-03T00:00')).availability).toBe('SALES_ENDED');
    expect((await at('2027-03-02T23:58')).salesEndLocal).toBe('2027-03-02T23:59');
  }, 60000);

  it('a window opening 09:00 SA is not yet on sale at 08:59 SA and on sale at 09:00 SA', async () => {
    vi.stubEnv('TZ', 'Pacific/Auckland');
    const { ev, saturday } = await paidEvent();
    await prisma.ticket.update({ where: { id: saturday }, data: { salesStart: parseSaLocal('2027-02-01T09:00')! } });
    const event = await prisma.event.findUniqueOrThrow({ where: { id: ev.eventId }, include: { eventDays: { where: { isArchived: false } } } });
    const at = async (local: string) =>
      (await buildPublicTicketSales(event, parseSaLocal(local)!)).ticketTypes.find((t) => t.id === saturday)!.availability;
    expect(await at('2027-02-01T08:59')).toBe('NOT_YET_ON_SALE');
    expect(await at('2027-02-01T09:00')).toBe('ON_SALE');
  }, 60000);
});
