import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { type InviteStatus, type PlatformRole } from '@prisma/client';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { ROUTE_NOT_FOUND_BODY } from '../../src/shared/middleware/feature.middleware.js';
import { resolveEventPlan, resolveEventPlanName } from '../../src/modules/subscription-tier-config/effective-plan.util.js';
import { writeTierConfigs, restoreTierConfigs, createCustomTier, onCustomTier, deleteCustomTierFixtures } from '../custom-tiers/custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  THE SUPER ADMIN CONSOLE (STEERING "Super admin console")
//
//  Read-only, platform-wide: stats, users, events, one event's detail and
//  guest list (each view audit-logged). The internal organisation and its
//  templates are never in them; anyone but a super admin gets the global 404.
// ─────────────────────────────────────────

const run = randomUUID().slice(0, 8);
const tenantIds: string[] = [];
const customTierIds: string[] = [];
const templateIds: string[] = [];
const extraUserIds: string[] = [];
let superAdmin: Actor;
let tenantAdmin: Actor;
let eventAdmin: Actor;
let vendor: Actor;
let tenantA: string;
let tenantB: string;
let customTierName: string;
let internalTenantId: string;
let statsBefore: Record<string, Record<string, number>>;
const ids = {} as Record<'draft' | 'live' | 'finished' | 'cancelled' | 'archived' | 'bDraft' | 'template' | 'liveDay', string>;
const guestIds = {} as Record<'accepted' | 'plusOne' | 'declined' | 'pending' | 'archived' | 'awaiting', string>;

const asSuper = () => headersFor(superAdmin);
const get = (path: string, actor: Actor = superAdmin) => request(app).get(path).set(headersFor(actor));

const makeEvent = async (tenantId: string, createdBy: string, name: string, data: Record<string, unknown> = {}, dayDate?: string) => {
  const event = await prisma.event.create({ data: { tenantId, createdByUserId: createdBy, name, createdBy, updatedBy: createdBy, ...data } });
  let dayId: string | null = null;
  if (dayDate) {
    dayId = (await prisma.eventDay.create({ data: { eventId: event.id, label: 'Day 1', date: new Date(dayDate), createdBy, updatedBy: createdBy } })).id;
  }
  return { id: event.id, dayId };
};

const makeGuest = async (
  eventId: string,
  by: string,
  g: { firstName: string; surname: string; email?: string; status?: InviteStatus | null; archived?: boolean; pendingApproval?: boolean; hostGuestId?: string; checkInDayId?: string }
) => {
  const guest = await prisma.guest.create({
    data: {
      eventId,
      firstName: g.firstName,
      surname: g.surname,
      email: g.email ?? null,
      isArchived: g.archived ?? false,
      pendingApproval: g.pendingApproval ?? false,
      hostGuestId: g.hostGuestId ?? null,
    },
  });
  if (g.status) {
    const invite = await prisma.invite.create({
      data: { eventId, guestId: guest.id, token: randomUUID(), status: g.status, deliveryMethod: 'EMAIL', createdBy: by, updatedBy: by },
    });
    if (g.checkInDayId) await prisma.checkIn.create({ data: { inviteId: invite.id, eventDayId: g.checkInDayId, checkedBy: by } });
  }
  return guest.id;
};

beforeAll(async () => {
  await writeTierConfigs();
  superAdmin = await createActor('SUPER_ADMIN', null);
  installFirebaseMock();
  internalTenantId = (await prisma.tenant.findFirstOrThrow({ where: { isInternal: true } })).id;

  // The numbers before this file's own rows exist.
  statsBefore = (await get('/api/admin/stats')).body.data;

  tenantA = (await createTenant(`Console A ${run}`)).id;
  tenantB = (await createTenant(`Console B ${run}`)).id;
  tenantIds.push(tenantA, tenantB);
  await prisma.tenant.update({ where: { id: tenantA }, data: { subscriptionTier: 'SPARK' } });
  const tier = await createCustomTier();
  customTierIds.push(tier.id);
  customTierName = tier.name;
  await onCustomTier(tenantB, tier.id);

  tenantAdmin = await createActor('TENANT_ADMIN', tenantA);
  eventAdmin = await createActor('EVENT_ADMIN', tenantA);
  vendor = await createActor('EVENT_VENDOR', tenantA);
  await prisma.user.update({ where: { id: tenantAdmin.id }, data: { username: `Zanele Khumalo ${run}` } });
  await prisma.user.update({ where: { id: eventAdmin.id }, data: { username: `Pieter Botha ${run}`, isActive: false } });

  const by = tenantAdmin.id;
  ids.draft = (await makeEvent(tenantA, by, `Console Draft ${run}`)).id;
  const live = await makeEvent(tenantA, by, `Console Gala ${run}`, { status: 'PUBLISHED', hostName: 'Host', visibility: 'PUBLIC' }, '2027-06-01');
  ids.live = live.id;
  ids.liveDay = live.dayId!;
  ids.finished = (await makeEvent(tenantA, by, `Console Finished ${run}`, { status: 'PUBLISHED' }, '2025-01-01')).id;
  ids.cancelled = (await makeEvent(tenantA, by, `Console Cancelled ${run}`, { status: 'CANCELLED' }, '2027-07-01')).id;
  ids.archived = (await makeEvent(tenantA, by, `Console Archived ${run}`, { status: 'PUBLISHED', isArchived: true, archivedAt: new Date() }, '2027-08-01')).id;
  ids.bDraft = (await makeEvent(tenantB, by, `Console B Draft ${run}`)).id;

  guestIds.accepted = await makeGuest(ids.live, by, { firstName: 'Thandi', surname: `Mokoena${run}`, email: `thandi.${run}@test.invalid`, status: 'ACCEPTED', checkInDayId: ids.liveDay });
  guestIds.plusOne = await makeGuest(ids.live, by, { firstName: 'Sipho', surname: 'Plus', status: 'ACCEPTED', hostGuestId: guestIds.accepted });
  guestIds.declined = await makeGuest(ids.live, by, { firstName: 'Lerato', surname: 'Declines', email: `lerato.${run}@test.invalid`, status: 'DECLINED' });
  guestIds.pending = await makeGuest(ids.live, by, { firstName: 'Ayanda', surname: 'Waits', status: 'PENDING' });
  guestIds.archived = await makeGuest(ids.live, by, { firstName: 'Gone', surname: 'Archived', status: 'ACCEPTED', archived: true, checkInDayId: ids.liveDay });
  guestIds.awaiting = await makeGuest(ids.live, by, { firstName: 'New', surname: 'Registrant', pendingApproval: true });

  // A template (the internal organisation's), live, with guests: never counted or listed.
  const template = await makeEvent(internalTenantId, superAdmin.id, `Console Template ${run}`, { status: 'PUBLISHED' }, '2027-06-02');
  ids.template = template.id;
  templateIds.push(template.id);
  for (let i = 0; i < 3; i++) await makeGuest(template.id, superAdmin.id, { firstName: 'Template', surname: `Guest${i}`, status: 'ACCEPTED' });
}, 120_000);

afterAll(async () => {
  await deleteCustomTierFixtures({ tenantIds, customTierIds });
  await deleteTenantsDeep(tenantIds);
  // The template and its guests.
  const invites = await prisma.invite.findMany({ where: { eventId: { in: templateIds } }, select: { id: true } });
  await prisma.invite.deleteMany({ where: { id: { in: invites.map((i) => i.id) } } });
  await prisma.guest.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.eventDay.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.event.deleteMany({ where: { id: { in: templateIds } } });
  await prisma.termsAcceptance.deleteMany({ where: { userId: { in: extraUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: extraUserIds } } });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await prisma.otpRecord.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
  await restoreTierConfigs();
}, 120_000);

beforeEach(() => installFirebaseMock());

describe('anyone but a super admin gets the global 404, on every route', () => {
  const paths = () => ['/api/admin/stats', '/api/admin/users', '/api/admin/events', `/api/admin/events/${ids.live}`, `/api/admin/events/${ids.live}/guests`];

  it.each(['TENANT_ADMIN', 'EVENT_ADMIN', 'EVENT_VENDOR'] as PlatformRole[])('%s', async (role) => {
    const actor = role === 'TENANT_ADMIN' ? tenantAdmin : role === 'EVENT_VENDOR' ? vendor : await createActor('EVENT_ADMIN', tenantA);
    for (const path of paths()) {
      const res = await get(path, actor);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toEqual(ROUTE_NOT_FOUND_BODY);
    }
    // ...and no guest list view was recorded for them.
    expect(await prisma.adminAuditEntry.count({ where: { actorUserId: actor.id } })).toBe(0);
  });

  it('a super admin reaches each one', async () => {
    for (const path of paths()) expect((await get(path)).status, path).toBe(200);
  });

  it('the routes beside them still work: per-tenant admin routes, and media purge still routed', async () => {
    expect((await get(`/api/tenants/${tenantA}/events`)).status).toBe(200);
    expect((await get(`/api/tenants/${tenantA}/users`)).status).toBe(200);
    const purge = await request(app).post(`/api/admin/events/${ids.live}/media-purge`).set(asSuper());
    expect(purge.body).not.toEqual(ROUTE_NOT_FOUND_BODY);
    const purgeByTenant = await request(app).post(`/api/admin/events/${ids.live}/media-purge`).set(headersFor(tenantAdmin));
    expect(purgeByTenant.status).toBe(404);
  });
});

describe('GET /api/admin/stats', () => {
  it('counts tenants, events by status and guests, without the internal organisation, its templates or archived guests', async () => {
    const res = await get('/api/admin/stats');
    expect(res.status).toBe(200);
    const after = res.body.data;
    const delta = (group: string, key: string) => after[group][key] - statsBefore[group]![key]!;
    expect(delta('tenants', 'total')).toBe(2);
    expect(delta('events', 'total')).toBe(6);
    expect(delta('events', 'draft')).toBe(2);
    expect(delta('events', 'live')).toBe(1);
    expect(delta('events', 'finished')).toBe(1);
    expect(delta('events', 'cancelled')).toBe(1);
    expect(delta('events', 'archived')).toBe(1);
    // Thandi, her plus-one, Lerato, Ayanda and the registrant: the archived
    // guest and the template's three are left out.
    expect(delta('guests', 'total')).toBe(5);
    // The split adds up.
    const e = after.events;
    expect(e.draft + e.live + e.finished + e.cancelled + e.archived).toBe(e.total);
  });
});

describe('GET /api/admin/users', () => {
  it('lists users with tenant name, role, status and last sign-in; filters by tenant and role; pages', async () => {
    const usedAt = new Date('2026-10-01T08:00:00Z');
    const deviceAt = new Date('2026-10-05T09:30:00Z');
    await prisma.otpRecord.create({ data: { userId: tenantAdmin.id, otp: 'x', expiresAt: usedAt, usedAt } });
    await prisma.deviceToken.create({ data: { userId: tenantAdmin.id, tokenHash: randomUUID(), expiresAt: new Date('2027-01-01'), lastUsedAt: deviceAt } });
    await prisma.otpRecord.create({ data: { userId: eventAdmin.id, otp: 'y', expiresAt: usedAt, usedAt } });

    const res = await get(`/api/admin/users?tenantId=${tenantA}&pageSize=100`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.items.map((u: { id: string }) => [u.id, u]));
    expect(byId.size).toBe(res.body.data.total);
    expect(byId.get(tenantAdmin.id)).toMatchObject({
      username: `Zanele Khumalo ${run}`,
      email: tenantAdmin.email,
      role: 'TENANT_ADMIN',
      status: 'ACTIVE',
      tenant: { id: tenantA, name: `Console A ${run}` },
      lastSignInAt: deviceAt.toISOString(),
    });
    expect(byId.get(eventAdmin.id)).toMatchObject({ status: 'SUSPENDED', lastSignInAt: usedAt.toISOString() });
    expect(byId.get(vendor.id)).toMatchObject({ role: 'EVENT_VENDOR', lastSignInAt: null });

    const admins = await get(`/api/admin/users?tenantId=${tenantA}&role=tenant_admin`);
    expect(admins.body.data.items.map((u: { id: string }) => u.id)).toEqual([tenantAdmin.id]);

    const paged = await get(`/api/admin/users?tenantId=${tenantA}&pageSize=1&page=2`);
    expect(paged.body.data).toMatchObject({ page: 2, pageSize: 1 });
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBe(res.body.data.total);
  });

  it('searches by name and by email, any case, word by word', async () => {
    const byName = await get(`/api/admin/users?search=${encodeURIComponent(`khumalo ZANELE ${run}`)}`);
    expect(byName.body.data.items.map((u: { id: string }) => u.id)).toEqual([tenantAdmin.id]);
    const byEmail = await get(`/api/admin/users?search=${encodeURIComponent(eventAdmin.email.toUpperCase())}`);
    expect(byEmail.body.data.items.map((u: { id: string }) => u.id)).toEqual([eventAdmin.id]);
  });

  it('a super admin is listed with no tenant; a user in the internal organisation is not listed', async () => {
    const own = await get(`/api/admin/users?search=${encodeURIComponent(superAdmin.email)}`);
    expect(own.body.data.items).toHaveLength(1);
    expect(own.body.data.items[0]).toMatchObject({ role: 'SUPER_ADMIN', tenant: null });

    const insider = await createActor('TENANT_ADMIN', internalTenantId);
    extraUserIds.push(insider.id);
    expect((await get(`/api/admin/users?search=${encodeURIComponent(insider.email)}`)).body.data.total).toBe(0);
    expect((await get(`/api/admin/users?tenantId=${internalTenantId}`)).body.data.total).toBe(0);
  });

  it('a role or paging it does not know is 400', async () => {
    expect((await get('/api/admin/users?role=OWNER')).status).toBe(400);
    expect((await get('/api/admin/users?page=0')).status).toBe(400);
    expect((await get('/api/admin/users?pageSize=abc')).status).toBe(400);
  });
});

describe('GET /api/admin/events', () => {
  const idsOf = (res: request.Response) => res.body.data.items.map((e: { id: string }) => e.id).sort();

  it("lists every status, with tenant name, dates, visibility, plan name and counts", async () => {
    const res = await get(`/api/admin/events?tenantId=${tenantA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5);
    const byId = new Map(res.body.data.items.map((e: { id: string }) => [e.id, e]));
    expect(byId.get(ids.draft)).toMatchObject({ status: 'DRAFT', firstDate: null, lastDate: null });
    expect(byId.get(ids.finished)).toMatchObject({ status: 'FINISHED' });
    expect(byId.get(ids.cancelled)).toMatchObject({ status: 'CANCELLED' });
    expect(byId.get(ids.archived)).toMatchObject({ status: 'ARCHIVED' });
    expect(byId.get(ids.live)).toMatchObject({
      name: `Console Gala ${run}`,
      status: 'LIVE',
      tenant: { id: tenantA, name: `Console A ${run}` },
      firstDate: '2027-06-01T00:00:00.000Z',
      lastDate: '2027-06-01T00:00:00.000Z',
      visibility: 'PUBLIC',
      planName: 'SPARK',
      // Thandi, her plus-one, Lerato and Ayanda; not the archived guest or
      // the registrant awaiting approval.
      counts: { invited: 4, accepted: 2, declined: 1, checkedIn: 1 },
    });

    const b = await get(`/api/admin/events?tenantId=${tenantB}`);
    expect(b.body.data.items[0]).toMatchObject({ id: ids.bDraft, planName: customTierName, tenant: { name: `Console B ${run}` } });
  });

  it('filters by status', async () => {
    const expected: Record<string, string[]> = {
      draft: [ids.draft],
      LIVE: [ids.live],
      finished: [ids.finished],
      cancelled: [ids.cancelled],
      archived: [ids.archived],
    };
    for (const [status, want] of Object.entries(expected)) {
      expect(idsOf(await get(`/api/admin/events?tenantId=${tenantA}&status=${status}`)), status).toEqual(want);
    }
  });

  it('searches by name and filters by a date range', async () => {
    expect(idsOf(await get(`/api/admin/events?search=${encodeURIComponent(`gala ${run}`)}`))).toEqual([ids.live]);
    expect(idsOf(await get(`/api/admin/events?tenantId=${tenantA}&from=2027-05-01&to=2027-06-30`))).toEqual([ids.live]);
    expect(idsOf(await get(`/api/admin/events?tenantId=${tenantA}&from=2027-06-02`))).toEqual([ids.archived, ids.cancelled].sort());
    expect(idsOf(await get(`/api/admin/events?tenantId=${tenantA}&to=2025-12-31`))).toEqual([ids.finished]);
  });

  it('never lists a template', async () => {
    expect((await get(`/api/admin/events?search=${encodeURIComponent(`Console Template ${run}`)}`)).body.data.total).toBe(0);
    expect((await get(`/api/admin/events?tenantId=${internalTenantId}`)).body.data.total).toBe(0);
    expect((await get(`/api/admin/events?tenantId=${internalTenantId}&status=LIVE`)).body.data.total).toBe(0);
  });

  it('a bad filter is 400', async () => {
    expect((await get('/api/admin/events?status=PUBLISHED')).status).toBe(400);
    expect((await get('/api/admin/events?from=2027-02-30')).status).toBe(400);
    expect((await get('/api/admin/events?from=2027-03-02&to=2027-03-01')).status).toBe(400);
  });
});

describe('resolveEventPlanName agrees with resolveEventPlan', () => {
  it('standard, standard with a pass, granted, and custom tier', async () => {
    const live = await prisma.event.findUniqueOrThrow({ where: { id: ids.live }, include: { eventDays: true, eventPass: true } });
    const cases = [
      { tenantId: tenantA, event: live },
      { tenantId: tenantA, event: { ...live, eventPass: { passTier: 'LARGE' as const } } },
      { tenantId: tenantA, event: { ...live, eventPass: { passTier: 'SMALL' as const }, grantedTier: 'ELEVATE' as const } },
      { tenantId: tenantB, event: { ...live, tenantId: tenantB, eventPass: { passTier: 'LARGE' as const } } },
    ];
    for (const c of cases) {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: c.tenantId }, include: { customTier: true } });
      expect(resolveEventPlanName(tenant, tenant.customTier?.name ?? null, c.event)).toBe((await resolveEventPlan(tenant, c.event)).name);
    }
  });
});

describe('GET /api/admin/events/:eventId', () => {
  it("returns the event's details, days and stats", async () => {
    const res = await get(`/api/admin/events/${ids.live}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: ids.live,
      name: `Console Gala ${run}`,
      hostName: 'Host',
      status: 'LIVE',
      ticketing: 'FREE',
      tenant: { id: tenantA, name: `Console A ${run}` },
      planName: 'SPARK',
      days: [{ id: ids.liveDay, label: 'Day 1', date: '2027-06-01T00:00:00.000Z' }],
      stats: { invited: 4, accepted: 2, declined: 1, pending: 1, checkedIn: 1, pendingApproval: 1 },
    });
  });

  it('opens an archived event; a template or an unknown id is 404', async () => {
    expect((await get(`/api/admin/events/${ids.archived}`)).body.data.status).toBe('ARCHIVED');
    expect((await get(`/api/admin/events/${ids.template}`)).status).toBe(404);
    expect((await get(`/api/admin/events/${randomUUID()}`)).status).toBe(404);
  });

  it('writes nothing', async () => {
    const before = await prisma.event.findUniqueOrThrow({ where: { id: ids.live } });
    const entries = await prisma.adminAuditEntry.count({ where: { actorUserId: superAdmin.id } });
    for (const path of ['/api/admin/stats', '/api/admin/users', '/api/admin/events', `/api/admin/events/${ids.live}`]) await get(path);
    expect(await prisma.event.findUniqueOrThrow({ where: { id: ids.live } })).toEqual(before);
    expect(await prisma.adminAuditEntry.count({ where: { actorUserId: superAdmin.id } })).toBe(entries);
  });
});

describe('GET /api/admin/events/:eventId/guests', () => {
  const views = () => prisma.adminAuditEntry.findMany({ where: { actorUserId: superAdmin.id, action: 'EVENT_GUEST_LIST_VIEWED' }, orderBy: { createdAt: 'asc' } });

  it("lists live guests with their RSVP status and check-in", async () => {
    const res = await get(`/api/admin/events/${ids.live}/guests?pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5);
    const byId = new Map(res.body.data.items.map((g: { id: string }) => [g.id, g]));
    expect(byId.has(guestIds.archived)).toBe(false);
    expect(byId.get(guestIds.accepted)).toMatchObject({ firstName: 'Thandi', rsvpStatus: 'ACCEPTED', checkedIn: true, checkIns: [{ eventDayId: ids.liveDay }] });
    expect(byId.get(guestIds.plusOne)).toMatchObject({ hostGuestId: guestIds.accepted, rsvpStatus: 'ACCEPTED', checkedIn: false, checkIns: [] });
    expect(byId.get(guestIds.declined)).toMatchObject({ rsvpStatus: 'DECLINED', checkedIn: false });
    expect(byId.get(guestIds.pending)).toMatchObject({ rsvpStatus: 'PENDING' });
    expect(byId.get(guestIds.awaiting)).toMatchObject({ rsvpStatus: null, pendingApproval: true });
  });

  it('searches by name and email, and pages', async () => {
    const bySurname = await get(`/api/admin/events/${ids.live}/guests?search=${encodeURIComponent(`mokoena${run}`)}`);
    expect(bySurname.body.data.items.map((g: { id: string }) => g.id)).toEqual([guestIds.accepted]);
    const byEmail = await get(`/api/admin/events/${ids.live}/guests?search=${encodeURIComponent(`LERATO.${run}`)}`);
    expect(byEmail.body.data.items.map((g: { id: string }) => g.id)).toEqual([guestIds.declined]);
    const paged = await get(`/api/admin/events/${ids.live}/guests?pageSize=2&page=3`);
    expect(paged.body.data).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(paged.body.data.items).toHaveLength(1);
  });

  it('each view leaves exactly one audit entry: who, which event, when; never the search words', async () => {
    const before = (await views()).length;
    const started = new Date();
    expect((await get(`/api/admin/events/${ids.live}/guests`)).status).toBe(200);
    let after = await views();
    expect(after.length - before).toBe(1);
    const entry = after[after.length - 1]!;
    expect(entry).toMatchObject({
      actorUserId: superAdmin.id,
      actorEmail: superAdmin.email,
      tenantId: tenantA,
      details: { eventId: ids.live, eventName: `Console Gala ${run}`, page: 1, pageSize: 25, searched: false },
    });
    expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);

    expect((await get(`/api/admin/events/${ids.live}/guests?search=Thandi`)).status).toBe(200);
    after = await views();
    expect(after.length - before).toBe(2);
    expect(after[after.length - 1]!.details).toMatchObject({ searched: true });
    expect(JSON.stringify(after[after.length - 1]!.details)).not.toContain('Thandi');
  });

  it('a template or an unknown event is 404, and records nothing', async () => {
    const before = (await views()).length;
    expect((await get(`/api/admin/events/${ids.template}/guests`)).status).toBe(404);
    expect((await get(`/api/admin/events/${randomUUID()}/guests`)).status).toBe(404);
    expect((await get('/api/admin/events/x/guests?page=0')).status).toBe(400);
    expect((await views()).length).toBe(before);
  });
});
