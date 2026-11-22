import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/shared/prisma/prisma.client.js';
import { createTenant, createActor, headersFor, deleteTenantsDeep, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  Ticket sales Round A fixtures: an organisation (Elevate unless asked)
//  with a Tenant Admin and an Event Admin, a published PUBLIC event with a
//  share token and two days, a payout account when asked, and HTTP helpers
//  for the ticket type, ticket sales and payout routes. Hard-deleted after
//  each test, audit entries included (they have no foreign key).
// ─────────────────────────────────────────

const tenantIds: string[] = [];

export const cleanupTicketSalesFixtures = async (): Promise<void> => {
  const ids = tenantIds.splice(0);
  if (!ids.length) return;
  const events = await prisma.event.findMany({ where: { tenantId: { in: ids } }, select: { id: true } });
  await prisma.checkInPass.deleteMany({ where: { eventId: { in: events.map((e) => e.id) } } });
  await prisma.eventPass.deleteMany({ where: { eventId: { in: events.map((e) => e.id) } } });
  await prisma.adminAuditEntry.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenant.updateMany({ where: { id: { in: ids } }, data: { customTierId: null } });
  await deleteTenantsDeep(ids);
};

// A bank account number no fixture shares with anything else.
export const ACCOUNT_NUMBER = '62012345678';
export const OTHER_ACCOUNT_NUMBER = '10987654321';

export interface Org {
  tenantId: string;
  admin: Actor;
  eventAdmin: Actor;
}

export const createOrg = async (tier: 'SPARK' | 'CELEBRATE' | 'ELEVATE' = 'ELEVATE'): Promise<Org> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  if (tier !== 'ELEVATE') await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: tier } });
  return {
    tenantId: tenant.id,
    admin: await createActor('TENANT_ADMIN', tenant.id),
    eventAdmin: await createActor('EVENT_ADMIN', tenant.id),
  };
};

// A working payout account, as if set up long ago.
export const givePayoutAccount = (tenantId: string) =>
  prisma.tenant.update({
    where: { id: tenantId },
    data: {
      paystackSubaccountCode: `ACCT_fixture_${randomUUID()}`,
      paystackSubaccountStatus: 'ACTIVE',
      paystackSettlementBankName: 'Fake Bank',
      paystackAccountNumberLast4: '0000',
      paystackAccountHolderName: 'Fixture Holder',
    },
  });

export interface TicketedEvent {
  eventId: string;
  shareToken: string;
  dayIds: string[];
}

// A published public event with two days (1 and 2 March 2027), each ending
// at the end of its date.
export const createTicketedEvent = async (org: Org, data: Record<string, unknown> = {}): Promise<TicketedEvent> => {
  const shareToken = `tix-${randomUUID()}`;
  const event = await prisma.event.create({
    data: {
      tenantId: org.tenantId,
      createdByUserId: org.admin.id,
      name: `Ticketed ${randomUUID()}`,
      hostName: 'Acme Events',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      shareToken,
      createdBy: org.admin.id,
      updatedBy: org.admin.id,
      ...data,
    },
  });
  const dayIds: string[] = [];
  for (const [i, date] of ['2027-03-01', '2027-03-02'].entries()) {
    const day = await prisma.eventDay.create({
      data: { eventId: event.id, label: `Day ${i + 1}`, date: new Date(date), location: `Venue ${i + 1}`, address: `${i + 1} Test Road`, createdBy: org.admin.id, updatedBy: org.admin.id },
    });
    dayIds.push(day.id);
  }
  return { eventId: event.id, shareToken, dayIds };
};

export const ticketsUrl = (eventId: string) => `/api/events/${eventId}/tickets`;
export const salesUrl = (eventId: string) => `/api/events/${eventId}/ticket-sales`;
export const PAYOUT_URL = '/api/payments/subaccount';

export const VALID_TYPE = { name: 'General admission', priceCents: 20_000, quantity: 100 };

export const createType = (actor: Actor, eventId: string, body: Record<string, unknown> = {}) =>
  request(app).post(ticketsUrl(eventId)).set(headersFor(actor)).send({ ...VALID_TYPE, ...body });

export const updateType = (actor: Actor, eventId: string, id: string, body: Record<string, unknown>) =>
  request(app).put(`${ticketsUrl(eventId)}/${id}`).set(headersFor(actor)).send(body);

// A sale, simulated: Round B's sold count reads the type's own counter.
export const simulateSale = (ticketId: string, sold: number, held = 0) =>
  prisma.ticket.update({ where: { id: ticketId }, data: { soldCount: sold, heldCount: held } });

export const setSales = (actor: Actor, eventId: string, body: Record<string, unknown>) =>
  request(app).put(salesUrl(eventId)).set(headersFor(actor)).send(body);

export { prisma };
