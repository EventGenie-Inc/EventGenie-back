import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { eventGrantService } from '../../src/modules/event-grant/event-grant.service.js';
import { resolveEventPlan } from '../../src/modules/subscription-tier-config/effective-plan.util.js';
import { assertWithinEventLimit } from '../../src/modules/subscription-tier-config/event-tier-enforcement.util.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import { writeTierConfigs, restoreTierConfigs, createCustomTier, deleteCustomTierFixtures } from './custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  GRANTED EVENTS (STEERING "Custom tiers"; behind customTiers)
//
//  The super admin builds a template in the internal e-velope organisation
//  (never visible to tenants) and grants it to chosen tenants, or to all
//  tenants created before a date (sign-ups included). Each gets its own
//  copy, once, with the grant's feature set, not counted against its event
//  limit, and an email that it's ready.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
const customTierIds: string[] = [];
const grantIds: string[] = [];
const templateIds: string[] = [];
let superAdmin: Actor;
let internalTenantId: string;
let templateId: string;

const asSuper = () => headersFor(superAdmin);

const sparkTenant = async (opts: { createdAt?: Date } = {}) => {
  const tenant = await createTenant(`Grant Tenant ${randomUUID().slice(0, 8)}`);
  tenantIds.push(tenant.id);
  await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: 'SPARK', ...(opts.createdAt && { createdAt: opts.createdAt }) } });
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  return { tenantId: tenant.id, email: tenant.email, admin };
};

const grant = (body: Record<string, unknown>) => request(app).post('/api/admin/event-grants').set(asSuper()).send(body);

const copiesOf = (grantId: string, tenantId: string) => prisma.event.findMany({ where: { eventGrantId: grantId, tenantId } });

beforeAll(async () => {
  await writeTierConfigs();
  superAdmin = await createActor('SUPER_ADMIN', null);
  installFirebaseMock();
  internalTenantId = (await prisma.tenant.findFirstOrThrow({ where: { isInternal: true } })).id;

  // The template, made through the route, then given a day and a question
  // (additional fields: Spark has none, the grant's Celebrate does).
  const res = await request(app)
    .post('/api/admin/event-templates')
    .set(headersFor(superAdmin))
    .send({ name: `Welcome braai ${randomUUID().slice(0, 8)}`, hostName: 'e-velope', description: 'Our welcome event' });
  expect(res.status).toBe(201);
  templateId = res.body.data.id;
  templateIds.push(templateId);
  const userId = superAdmin.id;
  await prisma.eventDay.create({
    data: { eventId: templateId, label: 'Day 1', date: new Date('2027-03-01'), location: 'Campus', address: '1 Jan Smuts Ave', capacity: 300, createdBy: userId, updatedBy: userId },
  });
  await prisma.rsvpField.create({
    data: { eventId: templateId, label: 'Society', fieldType: 'TEXT', isRequired: false, order: 0, createdBy: userId, updatedBy: userId },
  });
}, 60_000);

afterAll(async () => {
  await deleteCustomTierFixtures({ tenantIds, customTierIds, grantIds: [...grantIds, ...(await prisma.eventGrant.findMany({ where: { sourceEventId: { in: templateIds } }, select: { id: true } })).map((g) => g.id)] });
  await deleteTenantsDeep(tenantIds);
  await prisma.rsvpField.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.eventDay.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.memoryHub.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.eventAssignment.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.event.deleteMany({ where: { id: { in: templateIds } } });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
  await restoreTierConfigs();
}, 120_000);

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});
afterEach(() => vi.unstubAllEnvs());

describe('templates live in the internal organisation, never visible to tenants', () => {
  it('lists the template for the super admin; a tenant can neither list nor open it', async () => {
    const list = await request(app).get('/api/admin/event-templates').set(asSuper());
    expect(list.body.data.map((e: { id: string }) => e.id)).toContain(templateId);
    const org = await request(app).get('/api/admin/event-templates/organisation').set(asSuper());
    expect(org.body.data.id).toBe(internalTenantId);

    const { admin } = await sparkTenant();
    const events = await request(app).get('/api/events').set(headersFor(admin));
    expect(events.body.data.map((e: { id: string }) => e.id)).not.toContain(templateId);
    expect((await request(app).get(`/api/events/${templateId}`).set(headersFor(admin))).status).toBe(404);
    expect((await request(app).get('/api/admin/event-templates').set(headersFor(admin))).status).toBe(404);
  });
});

describe('granting to chosen tenants', () => {
  it('each gets its own draft copy with the granted feature set, not counted against its event limit, and an email', async () => {
    const a = await sparkTenant();
    const b = await sparkTenant();
    // A is at Spark's limit of 1 active event already.
    await prisma.event.create({ data: { tenantId: a.tenantId, createdByUserId: a.admin.id, name: 'Own event', createdBy: a.admin.id, updatedBy: a.admin.id } });

    const res = await grant({ sourceEventId: templateId, name: 'Freshers week', firstDate: '2027-04-01', grantedTier: 'CELEBRATE', tenantIds: [a.tenantId, b.tenantId] });
    expect(res.status).toBe(201);
    grantIds.push(res.body.data.id);
    expect(res.body.data.recipients).toHaveLength(2);
    expect(res.body.data.recipients.every((r: { status: string; eventId: string | null }) => r.status === 'DELIVERED' && r.eventId)).toBe(true);

    for (const t of [a, b]) {
      const [copy] = await copiesOf(res.body.data.id, t.tenantId);
      expect(copy).toMatchObject({ name: 'Freshers week', status: 'DRAFT', grantedTier: 'CELEBRATE', grantedCustomTierId: null, createdByUserId: t.admin.id });
      const days = await prisma.eventDay.findMany({ where: { eventId: copy!.id } });
      expect(days.map((d) => d.date.toISOString().slice(0, 10))).toEqual(['2027-04-01']);
      // The template day's venue capacity comes with it.
      expect(days.map((d) => d.capacity)).toEqual([300]);
      expect(await prisma.rsvpField.count({ where: { eventId: copy!.id } })).toBe(1);

      const mail = sentEmails().filter((m) => m.to === t.email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toBe('Freshers week is ready in your e-velope account');
      expect(mail[0]!.text).toContain(`/events/${copy!.id}/manage`);

      const detail = await request(app).get(`/api/events/${copy!.id}`).set(headersFor(t.admin));
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ eventGrantId: res.body.data.id, grantedTier: 'CELEBRATE' });
    }

    // Audit-logged: the grant (platform-wide), and each tenant's copy.
    expect(await prisma.adminAuditEntry.count({ where: { action: 'EVENT_GRANT_CREATED', details: { path: ['grantId'], equals: res.body.data.id } } })).toBe(1);
    for (const t of [a, b]) {
      const entries = await prisma.adminAuditEntry.findMany({ where: { tenantId: t.tenantId, action: 'EVENT_GRANTED' } });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorUserId: superAdmin.id, details: { grantId: res.body.data.id } });
    }

    // Not counted: A still has 1 active event as far as the limit goes.
    expect(await eventRepository.countActive(a.tenantId)).toBe(1);
    await expect(assertWithinEventLimit(a.tenantId)).rejects.toMatchObject({ code: 'EVENT_LIMIT_REACHED' });

    // The granted feature set: Celebrate's Memory Hub on the copy, Spark's
    // (none) on A's own event.
    const tenantA = (await prisma.tenant.findUnique({ where: { id: a.tenantId } }))!;
    const [copyA] = await copiesOf(res.body.data.id, a.tenantId);
    const copyFull = await prisma.event.findUniqueOrThrow({ where: { id: copyA!.id }, include: { eventPass: true, eventDays: true } });
    const own = await prisma.event.findFirstOrThrow({ where: { tenantId: a.tenantId, eventGrantId: null }, include: { eventPass: true, eventDays: true } });
    expect((await resolveEventPlan(tenantA, copyFull)).values.memoryHubEnabled).toBe(true);
    expect((await resolveEventPlan(tenantA, own)).values.memoryHubEnabled).toBe(false);
  });

  it('a tenant never gets the same grant twice: chosen again, delivered again, or two at once', async () => {
    const c = await sparkTenant();
    const d = await sparkTenant();
    const res = await grant({ sourceEventId: templateId, name: 'Once only', firstDate: '2027-05-01', grantedTier: 'ELEVATE', tenantIds: [c.tenantId] });
    grantIds.push(res.body.data.id);
    const grantId = res.body.data.id as string;

    const again = await request(app).post(`/api/admin/event-grants/${grantId}/recipients`).set(asSuper()).send({ tenantIds: [c.tenantId] });
    expect(again.status).toBe(200);
    expect(await eventGrantService.deliver(grantId, c.tenantId, { retryFailed: true })).toBe('SKIPPED');
    expect(await copiesOf(grantId, c.tenantId)).toHaveLength(1);

    const both = await Promise.all([
      eventGrantService.deliver(grantId, d.tenantId, { retryFailed: true }),
      eventGrantService.deliver(grantId, d.tenantId, { retryFailed: true }),
    ]);
    expect(both.sort()).toEqual(['DELIVERED', 'SKIPPED']);
    expect(await copiesOf(grantId, d.tenantId)).toHaveLength(1);
    expect(await prisma.eventGrantRecipient.count({ where: { grantId } })).toBe(2);
  });

  it('a retired custom tier, a paid template, another organisation\'s event and no recipients are refused', async () => {
    const retired = await createCustomTier({ isActive: false });
    customTierIds.push(retired.id);
    const t = await sparkTenant();

    const r1 = await grant({ sourceEventId: templateId, grantedCustomTierId: retired.id, tenantIds: [t.tenantId], firstDate: '2027-04-01' });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('CUSTOM_TIER_RETIRED');

    const own = await prisma.event.create({ data: { tenantId: t.tenantId, createdByUserId: t.admin.id, name: 'Theirs', createdBy: t.admin.id, updatedBy: t.admin.id } });
    const r2 = await grant({ sourceEventId: own.id, grantedTier: 'CELEBRATE', tenantIds: [t.tenantId] });
    expect(r2.status).toBe(404);
    expect(r2.body.code).toBe('EVENT_GRANT_TEMPLATE_NOT_FOUND');

    const r3 = await grant({ sourceEventId: templateId, grantedTier: 'CELEBRATE', firstDate: '2027-04-01' });
    expect(r3.status).toBe(422);
    expect(r3.body.code).toBe('EVENT_GRANT_RECIPIENTS_REQUIRED');

    await prisma.event.update({ where: { id: templateId }, data: { ticketing: 'PAID' } });
    const r4 = await grant({ sourceEventId: templateId, grantedTier: 'CELEBRATE', tenantIds: [t.tenantId], firstDate: '2027-04-01' });
    await prisma.event.update({ where: { id: templateId }, data: { ticketing: 'FREE' } });
    expect(r4.status).toBe(422);
    expect(r4.body.code).toBe('EVENT_GRANT_TEMPLATE_PAID');
    expect(await prisma.event.count({ where: { tenantId: t.tenantId, eventGrantId: { not: null } } })).toBe(0);
  });

  it('a custom tier as the feature set: the copy gets it', async () => {
    const tier = await createCustomTier({ memoryHubEnabled: true, maxMemoryHubBytesPerEvent: 777 });
    customTierIds.push(tier.id);
    const t = await sparkTenant();
    const res = await grant({ sourceEventId: templateId, grantedCustomTierId: tier.id, tenantIds: [t.tenantId], firstDate: '2027-04-01' });
    grantIds.push(res.body.data.id);
    const [copy] = await copiesOf(res.body.data.id, t.tenantId);
    expect(copy!.grantedCustomTierId).toBe(tier.id);
    const full = await prisma.event.findUniqueOrThrow({ where: { id: copy!.id }, include: { eventPass: true, eventDays: true } });
    const tenant = (await prisma.tenant.findUnique({ where: { id: t.tenantId } }))!;
    expect((await resolveEventPlan(tenant, full)).values.maxMemoryHubBytesPerEvent).toBe(777);
  });
});

describe('granting to all tenants, sign-ups included, until a date', () => {
  it('reaches a tenant that signed up before the date and not one after; once', async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const before = await sparkTenant();
    const after = await sparkTenant({ createdAt: new Date(until.getTime() + 60_000) });

    const res = await grant({ sourceEventId: templateId, name: 'Welcome', firstDate: '2027-04-01', grantedTier: 'CELEBRATE', toAllTenants: true, allTenantsUntil: until.toISOString() });
    expect(res.status).toBe(201);
    const grantId = res.body.data.id as string;
    grantIds.push(grantId);
    expect(res.body.data.recipients).toHaveLength(0); // the sweep delivers it

    const first = await eventGrantService.sweep({ tenantIds: [before.tenantId, after.tenantId] });
    expect(first).toEqual({ delivered: 1, failed: 0 });
    expect(await copiesOf(grantId, before.tenantId)).toHaveLength(1);
    expect(await copiesOf(grantId, after.tenantId)).toHaveLength(0);
    expect(sentEmails().filter((m) => m.to === before.email)).toHaveLength(1);

    expect(await eventGrantService.sweep({ tenantIds: [before.tenantId, after.tenantId] })).toEqual({ delivered: 0, failed: 0 });
    expect(await copiesOf(grantId, before.tenantId)).toHaveLength(1);
  });

  it('never reaches the internal organisation, and delivers nothing while customTiers is off', async () => {
    const t = await sparkTenant();
    const res = await grant({ sourceEventId: templateId, firstDate: '2027-04-01', grantedTier: 'CELEBRATE', toAllTenants: true, allTenantsUntil: new Date(Date.now() + 3600_000).toISOString() });
    grantIds.push(res.body.data.id);
    vi.stubEnv('FEATURES_DISABLED', 'customTiers');
    expect(await eventGrantService.sweep({ tenantIds: [t.tenantId, internalTenantId] })).toEqual({ delivered: 0, failed: 0 });
    vi.unstubAllEnvs();
    // t also qualifies for the earlier grant to all in this file: count this one's.
    await eventGrantService.sweep({ tenantIds: [t.tenantId, internalTenantId] });
    expect(await copiesOf(res.body.data.id, t.tenantId)).toHaveLength(1);
    expect(await prisma.eventGrantRecipient.count({ where: { grantId: res.body.data.id, tenantId: internalTenantId } })).toBe(0);
  });
});
