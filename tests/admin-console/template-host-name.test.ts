import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { clearSentEmails } from '../helpers/sent-emails.js';
import { HOST_NAME_MAX_CHARS } from '../../src/modules/event/event-host-name.util.js';
import { writeTierConfigs, restoreTierConfigs, deleteCustomTierFixtures } from '../custom-tiers/custom-tier-fixtures.js';

// ─────────────────────────────────────────
//  TEMPLATES NEED NO HOST NAME (STEERING "Host name", "Custom tiers")
//
//  A template (the internal organisation's event) is created and edited
//  without one. Each granted copy takes its receiving organisation's name;
//  a name that can't be a host name leaves the copy without one, still
//  delivered, with the reason on the recipient.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
const templateIds: string[] = [];
let superAdmin: Actor;

const asSuper = () => headersFor(superAdmin);

const createTemplate = async (body: Record<string, unknown> = {}) => {
  const res = await request(app).post('/api/admin/event-templates').set(asSuper()).send({ name: `Template ${randomUUID().slice(0, 8)}`, ...body });
  if (res.body.data?.id) templateIds.push(res.body.data.id);
  return res;
};

const tenantNamed = async (name: string) => {
  const tenant = await createTenant(name);
  tenantIds.push(tenant.id);
  const admin = await createActor('TENANT_ADMIN', tenant.id);
  return { tenantId: tenant.id, admin };
};

beforeAll(async () => {
  await writeTierConfigs();
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 60_000);

afterAll(async () => {
  const grantIds = (await prisma.eventGrant.findMany({ where: { sourceEventId: { in: templateIds } }, select: { id: true } })).map((g) => g.id);
  await deleteCustomTierFixtures({ tenantIds, grantIds });
  await deleteTenantsDeep(tenantIds);
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

describe('a template is created and edited without a host name', () => {
  it('POST /api/admin/event-templates without hostName is 201, with none stored', async () => {
    const res = await createTemplate();
    expect(res.status).toBe(201);
    expect(res.body.data.hostName).toBeNull();
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(stored.hostName).toBeNull();
  });

  it('a blank host name is accepted too, and a sent one is kept', async () => {
    expect((await createTemplate({ hostName: '   ' })).status).toBe(201);
    const named = await createTemplate({ hostName: '  e-velope  ' });
    expect(named.status).toBe(201);
    expect(named.body.data.hostName).toBe('e-velope');
  });

  it('a template with no host name is edited (PUT and the full update) without one', async () => {
    const created = await createTemplate();
    const id = created.body.data.id as string;
    const put = await request(app).put(`/api/events/${id}`).set(asSuper()).send({ name: 'Renamed template' });
    expect(put.status).toBe(200);
    const full = await request(app).put(`/api/events/${id}/full`).set(asSuper()).send({ event: { description: 'Edited' } });
    expect(full.status).toBe(200);
    expect((await prisma.event.findUniqueOrThrow({ where: { id } })).hostName).toBeNull();
  });

  it("an organisation's own event still needs one, on create and on edit", async () => {
    const { tenantId, admin } = await tenantNamed(`Host Rule ${randomUUID().slice(0, 8)}`);
    const created = await request(app).post('/api/events').set(headersFor(admin)).send({ name: 'No host' });
    expect(created.status).toBe(422);
    expect(created.body.code).toBe('EVENT_HOST_NAME_REQUIRED');

    const old = await prisma.event.create({ data: { tenantId, createdByUserId: admin.id, name: 'Older', createdBy: admin.id, updatedBy: admin.id } });
    const edit = await request(app).put(`/api/events/${old.id}`).set(headersFor(admin)).send({ name: 'Older, renamed' });
    expect(edit.status).toBe(422);
    expect(edit.body.code).toBe('EVENT_HOST_NAME_REQUIRED');
    const full = await request(app).put(`/api/events/${old.id}/full`).set(headersFor(admin)).send({ event: { description: 'x' } });
    expect(full.status).toBe(422);
    expect(full.body.code).toBe('EVENT_HOST_NAME_REQUIRED');
  });
});

describe("a granted copy's host name is the receiving organisation's name", () => {
  it("takes the tenant's name (not the template's), editable by them; no notice", async () => {
    const template = await createTemplate({ hostName: 'e-velope' });
    const org = await tenantNamed(`  Wits Chess Society ${randomUUID().slice(0, 6)}  `);
    const expected = (await prisma.tenant.findUniqueOrThrow({ where: { id: org.tenantId } })).name.trim();

    const res = await request(app)
      .post('/api/admin/event-grants')
      .set(asSuper())
      .send({ sourceEventId: template.body.data.id, firstDate: '2027-05-01', grantedTier: 'CELEBRATE', tenantIds: [org.tenantId] });
    expect(res.status).toBe(201);
    const [recipient] = res.body.data.recipients;
    expect(recipient).toMatchObject({ status: 'DELIVERED', notice: null });

    const copy = await prisma.event.findUniqueOrThrow({ where: { id: recipient.eventId } });
    expect(copy.hostName).toBe(expected);

    const edit = await request(app).put(`/api/events/${copy.id}`).set(headersFor(org.admin)).send({ hostName: 'The Chess Club' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.hostName).toBe('The Chess Club');
  });

  it('a template without a host name gives the copy the tenant name too', async () => {
    const template = await createTemplate();
    const org = await tenantNamed(`Orientation Org ${randomUUID().slice(0, 6)}`);
    const res = await request(app)
      .post('/api/admin/event-grants')
      .set(asSuper())
      .send({ sourceEventId: template.body.data.id, firstDate: '2027-05-01', grantedTier: 'SPARK', tenantIds: [org.tenantId] });
    expect(res.status).toBe(201);
    const copy = await prisma.event.findUniqueOrThrow({ where: { id: res.body.data.recipients[0].eventId } });
    expect(copy.hostName).toBe((await prisma.tenant.findUniqueOrThrow({ where: { id: org.tenantId } })).name);
  });

  it("a name too long to be a host name: the copy is still made, without one, and the recipient says why", async () => {
    const template = await createTemplate({ hostName: 'e-velope' });
    const org = await tenantNamed(`L${'o'.repeat(HOST_NAME_MAX_CHARS)}ng ${randomUUID().slice(0, 6)}`);
    const res = await request(app)
      .post('/api/admin/event-grants')
      .set(asSuper())
      .send({ sourceEventId: template.body.data.id, firstDate: '2027-05-01', grantedTier: 'CELEBRATE', tenantIds: [org.tenantId] });
    expect(res.status).toBe(201);
    const [recipient] = res.body.data.recipients;
    expect(recipient.status).toBe('DELIVERED');
    expect(recipient.eventId).toBeTruthy();
    expect(recipient.failureReason).toBeNull();
    expect(recipient.notice).toMatch(/longer than a host name may be/);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: recipient.eventId } })).hostName).toBeNull();

    const read = await request(app).get(`/api/admin/event-grants/${res.body.data.id}`).set(asSuper());
    expect(read.body.data.recipients[0].notice).toBe(recipient.notice);
  });

  it('a blank organisation name: the copy is made without one, with the reason', async () => {
    const template = await createTemplate({ hostName: 'e-velope' });
    const org = await tenantNamed('   ');
    const res = await request(app)
      .post('/api/admin/event-grants')
      .set(asSuper())
      .send({ sourceEventId: template.body.data.id, firstDate: '2027-05-01', grantedTier: 'CELEBRATE', tenantIds: [org.tenantId] });
    expect(res.status).toBe(201);
    const [recipient] = res.body.data.recipients;
    expect(recipient).toMatchObject({ status: 'DELIVERED', failureReason: null });
    expect(recipient.notice).toMatch(/has no name/);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: recipient.eventId } })).hostName).toBeNull();
  });
});
