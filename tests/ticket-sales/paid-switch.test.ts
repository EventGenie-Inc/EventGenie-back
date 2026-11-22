import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createCustomTier, deleteCustomTierFixtures } from '../custom-tiers/custom-tier-fixtures.js';
import { register, view } from '../public-events/helpers.js';
import { eventService } from '../../src/modules/event/event.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import {
  cleanupTicketSalesFixtures,
  createOrg,
  createTicketedEvent,
  createType,
  givePayoutAccount,
  simulateSale,
  salesUrl,
  setSales,
  prisma,
  type Org,
  type TicketedEvent,
} from './helpers.js';

// ─────────────────────────────────────────
//  THE PAID SWITCH (ticket sales Round A) — /api/events/:eventId/ticket-sales
//
//  Switching ticket sales on is the only way an event becomes paid. It needs
//  a public event, an active payout account, an active ticket type, the
//  `ticketing` flag and paidTicketingEnabled on the event's effective plan
//  (and registration approval off). Off is refused after a sale; pausing
//  works instead. While paid: no free registration, no RSVP check-in passes.
// ─────────────────────────────────────────

const customTierIds: string[] = [];

beforeEach(() => {
  installFirebaseMock();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTicketSalesFixtures();
  if (customTierIds.length) await deleteCustomTierFixtures({ customTierIds: customTierIds.splice(0) });
});

// Everything switching on needs.
const ready = async (tier: 'SPARK' | 'CELEBRATE' | 'ELEVATE' = 'ELEVATE') => {
  const org = await createOrg(tier);
  await givePayoutAccount(org.tenantId);
  const ev = await createTicketedEvent(org);
  const type = await createType(org.admin, ev.eventId);
  expect(type.status).toBe(201);
  return { org, ev, ticketId: type.body.data.id as string };
};

const switchOn = (org: Org, ev: TicketedEvent) => setSales(org.admin, ev.eventId, { enabled: true });
const ticketingOf = async (ev: TicketedEvent) => (await prisma.event.findUniqueOrThrow({ where: { id: ev.eventId } })).ticketing;

describe('switching on refuses without each requirement', () => {
  it('ready: switched on, and the event is paid', async () => {
    const { org, ev } = await ready();
    const status = await request(app).get(salesUrl(ev.eventId)).set(headersFor(org.admin));
    expect(status.body.data).toEqual({
      enabled: false,
      paused: false,
      ticketsSold: 0,
      canEnable: true,
      canDisable: true,
      requirements: { publicEvent: true, planAllowsTicketSales: true, payoutAccountActive: true, activeTicketType: true, registrationApprovalOff: true },
    });
    const res = await switchOn(org, ev);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, paused: false });
    expect(await ticketingOf(ev)).toBe('PAID');
  }, 60000);

  it('a private event', async () => {
    const { org, ev } = await ready();
    await prisma.event.update({ where: { id: ev.eventId }, data: { visibility: 'PRIVATE' } });
    const res = await switchOn(org, ev);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_SALES_PUBLIC_ONLY');
    expect(await ticketingOf(ev)).toBe('FREE');
  }, 60000);

  it('no active payout account (none, or one Paystack has not activated)', async () => {
    const { org, ev } = await ready();
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountStatus: 'PENDING' } });
    const pending = await switchOn(org, ev);
    expect(pending.status).toBe(422);
    expect(pending.body.code).toBe('TICKET_SALES_PAYOUT_ACCOUNT_REQUIRED');
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountStatus: 'NOT_STARTED', paystackSubaccountCode: null } });
    expect((await switchOn(org, ev)).body.code).toBe('TICKET_SALES_PAYOUT_ACCOUNT_REQUIRED');
    expect(await ticketingOf(ev)).toBe('FREE');
  }, 60000);

  it('no active ticket type (none, or only hidden ones)', async () => {
    const { org, ev, ticketId } = await ready();
    await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'HIDDEN' } });
    const res = await switchOn(org, ev);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_SALES_ACTIVE_TYPE_REQUIRED');
    expect(await ticketingOf(ev)).toBe('FREE');
  }, 60000);

  it('the ticketing flag off: the switch is the global 404', async () => {
    const { org, ev } = await ready();
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    const res = await switchOn(org, ev);
    expect(res.status).toBe(404);
    expect(await ticketingOf(ev)).toBe('FREE');
  }, 60000);

  it('registration approval on', async () => {
    const { org, ev } = await ready();
    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationAutoApprove: false } });
    const res = await switchOn(org, ev);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_SALES_REGISTRATION_APPROVAL_ON');
  }, 60000);
});

describe('the plan setting (paidTicketingEnabled, on the event\'s effective plan)', () => {
  it('Spark is refused, with the plan named', async () => {
    const { org, ev } = await ready('SPARK');
    const res = await switchOn(org, ev);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TICKET_SALES_NOT_ON_PLAN');
    // The plan's display name, never its code (tierRefusalMessage).
    expect(res.body.message).toContain('Spark');
    expect(res.body.message).not.toContain('SPARK');
    expect(res.body.message).toBe('The Spark plan does not support paid ticketing. Upgrade your plan, or buy an Event Pass for this event, to sell tickets.');
    expect(await ticketingOf(ev)).toBe('FREE');
  }, 60000);

  it('Celebrate and Elevate are allowed', async () => {
    for (const tier of ['CELEBRATE', 'ELEVATE'] as const) {
      const { org, ev } = await ready(tier);
      const res = await switchOn(org, ev);
      expect(res.status, tier).toBe(200);
    }
  }, 60000);

  it('a Spark event with an Event Pass is allowed', async () => {
    const { org, ev } = await ready('SPARK');
    await prisma.eventPass.create({ data: { eventId: ev.eventId, tenantId: org.tenantId, passTier: 'SMALL' } });
    expect((await switchOn(org, ev)).status).toBe(200);
  }, 60000);

  it('a custom tier with the setting on is allowed; with it off, refused', async () => {
    const on = await createCustomTier({ paidTicketingEnabled: true });
    const off = await createCustomTier({ paidTicketingEnabled: false });
    customTierIds.push(on.id, off.id);

    const a = await ready('SPARK');
    await prisma.tenant.update({ where: { id: a.org.tenantId }, data: { customTierId: on.id, customTierAssignedAt: new Date() } });
    expect((await switchOn(a.org, a.ev)).status).toBe(200);

    const b = await ready('ELEVATE');
    await prisma.tenant.update({ where: { id: b.org.tenantId }, data: { customTierId: off.id, customTierAssignedAt: new Date() } });
    const refused = await switchOn(b.org, b.ev);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('TICKET_SALES_NOT_ON_PLAN');
    // A custom tier's refusal names it, with the contact wording.
    expect(refused.body.message).toBe(`Paid ticketing isn't available on your ${off.name} plan. Contact us at admin@e-velope.co.za if you need it.`);
  }, 60000);
});

describe('switching off and pausing', () => {
  it('off is allowed before any sale', async () => {
    const { org, ev } = await ready();
    await switchOn(org, ev);
    const res = await setSales(org.admin, ev.eventId, { enabled: false });
    expect(res.status).toBe(200);
    expect(await ticketingOf(ev)).toBe('FREE');
  }, 60000);

  it('off is refused once a ticket is sold (and through an event save too); pausing works', async () => {
    const { org, ev, ticketId } = await ready();
    await switchOn(org, ev);
    await simulateSale(ticketId, 1);

    const off = await setSales(org.admin, ev.eventId, { enabled: false });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('TICKET_SALES_HAVE_SALES');
    const save = await request(app).put(`/api/events/${ev.eventId}`).set(headersFor(org.admin)).send({ ticketing: 'FREE' });
    expect(save.status).toBe(409);
    expect(save.body.code).toBe('TICKET_SALES_HAVE_SALES');
    expect(await ticketingOf(ev)).toBe('PAID');

    const paused = await setSales(org.admin, ev.eventId, { paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ enabled: true, paused: true, ticketsSold: 1, canDisable: false });
    expect((await view(ev.shareToken)).body.data.ticketSales.paused).toBe(true);
    expect((await setSales(org.admin, ev.eventId, { paused: false })).body.data.paused).toBe(false);
  }, 60000);

  it('pausing a free event is refused', async () => {
    const { org, ev } = await ready();
    const res = await setSales(org.admin, ev.eventId, { paused: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_SALES_NOT_ENABLED');
  }, 60000);
});

describe('no other path makes an event paid', () => {
  it('create, update, the full update and the wizard refuse PAID; re-sending the stored value saves', async () => {
    const { org, ev } = await ready();
    await expect(eventService.create(org.tenantId, org.admin.id, { name: 'Paid at birth', hostName: 'Acme', ticketing: 'PAID' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'TICKET_SALES_USE_SWITCH',
    });
    const update = await request(app).put(`/api/events/${ev.eventId}`).set(headersFor(org.admin)).send({ ticketing: 'PAID' });
    expect(update.status).toBe(422);
    expect(update.body.code).toBe('TICKET_SALES_USE_SWITCH');
    const full = await request(app).put(`/api/events/${ev.eventId}/full`).set(headersFor(org.admin)).send({ event: { ticketing: 'PAID' } });
    expect(full.status).toBe(422);
    expect(full.body.code).toBe('TICKET_SALES_USE_SWITCH');
    await eventDraftRepository.upsert(org.tenantId, org.admin.id, {
      currentStep: 4,
      payload: { name: 'Wizard paid', hostName: 'Acme', visibility: 'PUBLIC', ticketing: 'PAID', days: [{ label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Hall', address: '1 Road' }] },
    });
    await expect(eventDraftService.materialize(org.tenantId, org.admin.id)).rejects.toMatchObject({ statusCode: 422, code: 'TICKET_SALES_USE_SWITCH' });
    expect(await ticketingOf(ev)).toBe('FREE');

    // Paid through the switch, then saved with ticketing re-sent: fine.
    await switchOn(org, ev);
    const resent = await request(app).put(`/api/events/${ev.eventId}`).set(headersFor(org.admin)).send({ name: 'Renamed', ticketing: 'PAID' });
    expect(resent.status).toBe(200);
  }, 60000);

  it('a paid event stays public, and a paid private event is not published', async () => {
    const { org, ev } = await ready();
    await switchOn(org, ev);
    const priv = await request(app).put(`/api/events/${ev.eventId}`).set(headersFor(org.admin)).send({ visibility: 'PRIVATE' });
    expect(priv.status).toBe(422);
    expect(priv.body.code).toBe('TICKET_SALES_PUBLIC_ONLY');

    const legacy = await createTicketedEvent(org, { status: 'DRAFT', visibility: 'PRIVATE', ticketing: 'PAID' });
    const publish = await request(app).post(`/api/events/${legacy.eventId}/publish`).set(headersFor(org.admin));
    expect(publish.status).toBe(422);
    expect(publish.body.code).toBe('TICKET_SALES_PUBLIC_ONLY');
  }, 60000);
});

describe('while paid', () => {
  it('free registration is refused, approval can\'t be switched on, and the page shows tickets', async () => {
    const { org, ev } = await ready();
    expect((await register(ev.shareToken, {})).status).toBe(201);
    await switchOn(org, ev);

    const guestsBefore = await prisma.guest.count({ where: { eventId: ev.eventId } });
    const res = await register(ev.shareToken, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'REGISTRATION_TICKETS_ONLY', message: 'This event sells tickets, so there is no free registration. Get a ticket instead.' });
    expect(await prisma.guest.count({ where: { eventId: ev.eventId } })).toBe(guestsBefore);

    const page = await view(ev.shareToken);
    expect(page.body.data.registration).toMatchObject({ isOpen: false, code: 'TICKETS_ONLY' });
    expect(page.body.data.ticketSales.ticketTypes).toHaveLength(1);

    const approval = await request(app).put(`/api/events/${ev.eventId}/registration-settings`).set(headersFor(org.admin)).send({ autoApprove: false });
    expect(approval.status).toBe(422);
    expect(approval.body.code).toBe('REGISTRATION_SETTINGS_APPROVAL_PAID_EVENT');
  }, 60000);

  it('no RSVP check-in passes are issued, and those from before are revoked', async () => {
    const { org, ev } = await ready();
    const email = `early-${Date.now()}@test.invalid`;
    expect((await register(ev.shareToken, { email })).status).toBe(201);
    const guest = await prisma.guest.findFirstOrThrow({ where: { eventId: ev.eventId, email } });
    const invite = await prisma.invite.findFirstOrThrow({ where: { guestId: guest.id } });
    const before = await request(app).post('/api/rsvp/passes').send({ token: invite.token });
    expect(before.status).toBe(200);
    expect(before.body.data.passes.length).toBeGreaterThan(0);

    await switchOn(org, ev);
    const after = await request(app).post('/api/rsvp/passes').send({ token: invite.token });
    expect(after.status).toBe(200);
    expect(after.body.data.passes).toEqual([]);
    expect(await prisma.checkInPass.count({ where: { guestId: guest.id, status: 'ACTIVE' } })).toBe(0);
  }, 60000);
});

describe('a downgrade never breaks a paid event', () => {
  // Paid while on Elevate, then the organisation lands on Spark (a lapse,
  // a downgrade): the plan was checked when sales were switched on, never
  // again.
  const paidThenSpark = async () => {
    const r = await ready('ELEVATE');
    expect((await switchOn(r.org, r.ev)).status).toBe(200);
    await prisma.tenant.update({ where: { id: r.org.tenantId }, data: { subscriptionTier: 'SPARK' } });
    return r;
  };

  it('the paid event can still be edited, the full form re-sending PUBLIC and PAID, and stays on sale', async () => {
    const { org, ev } = await paidThenSpark();
    const h = headersFor(org.admin);
    const save = await request(app).put(`/api/events/${ev.eventId}`).set(h).send({ name: 'Renamed after the downgrade', visibility: 'PUBLIC', ticketing: 'PAID' });
    expect(save.status).toBe(200);
    expect(save.body.data).toMatchObject({ name: 'Renamed after the downgrade', ticketing: 'PAID' });
    const full = await request(app).put(`/api/events/${ev.eventId}/full`).set(h).send({ event: { name: 'Full save', visibility: 'PUBLIC', ticketing: 'PAID' } });
    expect(full.status).toBe(200);

    // A payout account with a change waiting, or not active at Paystack:
    // editing is still fine.
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountStatus: 'PENDING' } });
    expect((await request(app).put(`/api/events/${ev.eventId}`).set(h).send({ description: 'Still editable', ticketing: 'PAID' })).status).toBe(200);
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountStatus: 'ACTIVE' } });

    const sales = (await view(ev.shareToken)).body.data.ticketSales;
    expect(sales.paused).toBe(false);
    expect(sales.ticketTypes.map((t: { availability: string }) => t.availability)).toEqual(['ON_SALE']);
    expect((await request(app).get(salesUrl(ev.eventId)).set(h)).body.data).toMatchObject({ enabled: true, paused: false });
  }, 60000);

  it('switching sales on for a new event on Spark is still refused', async () => {
    const { org } = await paidThenSpark();
    const fresh = await createTicketedEvent(org);
    expect((await createType(org.admin, fresh.eventId)).status).toBe(201);
    const res = await switchOn(org, fresh);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TICKET_SALES_NOT_ON_PLAN');
  }, 60000);

  it('resuming after a pause works on Spark; it still needs an active payout account and an active type', async () => {
    const { org, ev, ticketId } = await ready('ELEVATE');
    await switchOn(org, ev);
    expect((await setSales(org.admin, ev.eventId, { paused: true })).status).toBe(200);
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { subscriptionTier: 'SPARK' } });

    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountStatus: 'PENDING' } });
    const noPayout = await setSales(org.admin, ev.eventId, { paused: false });
    expect(noPayout.status).toBe(422);
    expect(noPayout.body.code).toBe('TICKET_SALES_PAYOUT_ACCOUNT_REQUIRED');
    await prisma.tenant.update({ where: { id: org.tenantId }, data: { paystackSubaccountStatus: 'ACTIVE' } });

    await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'HIDDEN' } });
    const noType = await setSales(org.admin, ev.eventId, { paused: false });
    expect(noType.status).toBe(422);
    expect(noType.body.code).toBe('TICKET_SALES_ACTIVE_TYPE_REQUIRED');
    await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'ACTIVE' } });

    const resumed = await setSales(org.admin, ev.eventId, { paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toMatchObject({ enabled: true, paused: false });
  }, 60000);

  it('publishing a paid draft re-checks neither the plan nor the payout account', async () => {
    const org = await createOrg('SPARK');
    const draft = await createTicketedEvent(org, { status: 'DRAFT', ticketing: 'PAID' });
    const res = await request(app).post(`/api/events/${draft.eventId}/publish`).set(headersFor(org.admin));
    expect(res.status).toBe(200);
  }, 60000);
});
