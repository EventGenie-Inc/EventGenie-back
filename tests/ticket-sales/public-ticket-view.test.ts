import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { installFirebaseMock } from '../helpers/team.js';
import { view } from '../public-events/helpers.js';
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
      ['allInPriceCents', 'availability', 'days', 'description', 'fees', 'id', 'maxPerOrder', 'name', 'priceCents', 'remaining', 'salesEnd', 'salesStart'].sort()
    );
    // R200: R212.23 all in; the split adds up.
    expect(general).toMatchObject({
      description: 'Both days',
      priceCents: 20_000,
      allInPriceCents: 21_223,
      fees: { commissionCents: 400, platformFixedFeeCents: 0, processingFeeCents: 823, totalCents: 1_223 },
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
