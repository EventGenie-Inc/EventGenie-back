import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { storageEnv } from '../../src/modules/upload/upload-folders.js';

// ─────────────────────────────────────────
//  TEMPLATE EVENTS: UPLOADS AND DESIGNS (STEERING "Custom tiers")
//
//  A template is an event of the internal e-velope organisation, and works
//  fully for a super admin through the ordinary routes: its cover (on a new
//  template and an existing one), its invitation design's upload, and the
//  design routes, with the same StoredFile records and paths as any event
//  (<env>/t/<internal id>/...). No tenant can see any of it.
// ─────────────────────────────────────────

let superAdmin: Actor;
let tenantAdmin: Actor;
let internalTenantId: string;
const tenantIds: string[] = [];
const templateIds: string[] = [];

const asSuper = () => headersFor(superAdmin);

const TEMPLATE_DESIGN = {
  kind: 'TEMPLATE',
  templateId: 'wedding',
  templateVersion: 1,
  overrides: { elements: { 'host-names': { color: '#1f2937', fontFamily: 'Great Vibes', fontSize: 72, text: 'e-velope' } } },
};

// What the browser does with a signature: upload to Cloudinary (here, the
// fake), and get back the public id and the delivery URL.
const uploadWith = (data: { folder: string; publicId: string }, bytes = 1000) => {
  const publicId = `${data.folder}/${data.publicId}`;
  fakeCloudinary.put(publicId, { bytes, format: 'jpg' });
  const { cloudName } = requireCloudinaryConfig();
  return { publicId, url: `https://res.cloudinary.com/${cloudName}/image/upload/v1700000000/${publicId}.jpg` };
};

const createTemplate = async (body: Record<string, unknown> = {}) => {
  const res = await request(app)
    .post('/api/admin/event-templates')
    .set(asSuper())
    .send({ name: `Template ${randomUUID().slice(0, 8)}`, hostName: 'e-velope', ...body });
  if (res.body.data?.id) templateIds.push(res.body.data.id);
  return res;
};

beforeAll(async () => {
  installFirebaseMock();
  superAdmin = await createActor('SUPER_ADMIN', null);
  internalTenantId = (await prisma.tenant.findFirstOrThrow({ where: { isInternal: true } })).id;
  const tenant = await createTenant(`Template Upload Tenant ${randomUUID().slice(0, 8)}`);
  tenantIds.push(tenant.id);
  tenantAdmin = await createActor('TENANT_ADMIN', tenant.id);
}, 60_000);

afterAll(async () => {
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.event.updateMany({ where: { id: { in: templateIds } }, data: { coverFileId: null } });
  await prisma.storedFile.deleteMany({ where: { OR: [{ eventId: { in: templateIds } }, { tenantId: internalTenantId, uploadedByUserId: superAdmin.id }] } });
  await prisma.memoryHub.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.eventAssignment.deleteMany({ where: { eventId: { in: templateIds } } });
  await prisma.event.deleteMany({ where: { id: { in: templateIds } } });
  await prisma.adminAuditEntry.deleteMany({ where: { actorUserId: superAdmin.id } });
  await deleteTenantsDeep(tenantIds);
  await prisma.termsAcceptance.deleteMany({ where: { userId: superAdmin.id } });
  await prisma.user.delete({ where: { id: superAdmin.id } });
}, 120_000);

beforeEach(() => installFirebaseMock());

describe('a new template with a cover', () => {
  it("signs a super admin's cover with no event into the internal organisation's cover folder, and the new template takes it", async () => {
    const sig = await request(app).post('/api/uploads/signature').set(asSuper()).send({ purpose: 'EVENT_COVER' });
    expect(sig.status).toBe(200);
    expect(sig.body.data.folder).toBe(`${storageEnv()}/t/${internalTenantId}/cover`);

    const cover = uploadWith(sig.body.data);
    const res = await createTemplate({ coverImagePublicId: cover.publicId, coverImageUrl: cover.url });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ tenantId: internalTenantId, coverImagePublicId: cover.publicId, coverImageUrl: cover.url });

    const file = await prisma.storedFile.findUniqueOrThrow({ where: { publicId: cover.publicId } });
    expect(file).toMatchObject({ kind: 'COVER', tenantId: internalTenantId, eventId: res.body.data.id, status: 'ATTACHED', uploadedByUserId: superAdmin.id });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: res.body.data.id } })).coverFileId).toBe(file.id);
  }, 30_000);

  it("a tenant can't use a cover signed for the internal organisation", async () => {
    const sig = await request(app).post('/api/uploads/signature').set(asSuper()).send({ purpose: 'EVENT_COVER' });
    const cover = uploadWith(sig.body.data);
    const res = await request(app)
      .post('/api/events')
      .set(headersFor(tenantAdmin))
      .send({ name: 'Stolen cover', hostName: 'Host', coverImagePublicId: cover.publicId, coverImageUrl: cover.url });
    expect(res.status).toBe(422);
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { publicId: cover.publicId } })).status).not.toBe('ATTACHED');
  }, 30_000);
});

describe("an existing template's cover", () => {
  it('signs into the template\'s own folder, and an event save replaces the old cover', async () => {
    const created = await createTemplate();
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const sign = () => request(app).post('/api/uploads/signature').set(asSuper()).send({ purpose: 'EVENT_COVER', eventId: id });
    const first = await sign();
    expect(first.status).toBe(200);
    expect(first.body.data.folder).toBe(`${storageEnv()}/t/${internalTenantId}/e/${id}/cover`);
    const a = uploadWith(first.body.data);
    const saveA = await request(app).put(`/api/events/${id}`).set(asSuper()).send({ coverImagePublicId: a.publicId, coverImageUrl: a.url });
    expect(saveA.status).toBe(200);
    expect(saveA.body.data.coverImagePublicId).toBe(a.publicId);
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { publicId: a.publicId } })).status).toBe('ATTACHED');

    const b = uploadWith((await sign()).body.data);
    const saveB = await request(app).put(`/api/events/${id}`).set(asSuper()).send({ coverImagePublicId: b.publicId, coverImageUrl: b.url });
    expect(saveB.status).toBe(200);
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { publicId: b.publicId } })).status).toBe('ATTACHED');
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { publicId: a.publicId } })).status).toBe('DELETE_REQUESTED');
  }, 30_000);
});

describe("a template's invitation design", () => {
  it('signs, saves, reads and replaces an uploaded design as a super admin, in the template\'s design folder', async () => {
    const created = await createTemplate();
    const id = created.body.data.id as string;
    const url = `/api/events/${id}/invitation-design`;

    const sig = await request(app).post(`${url}/upload-signature`).set(asSuper()).send({});
    expect(sig.status).toBe(200);
    expect(sig.body.data.folder).toBe(`${storageEnv()}/t/${internalTenantId}/e/${id}/design`);
    const image = uploadWith(sig.body.data);

    const body = { kind: 'UPLOAD', imageUrl: image.url, cloudinaryPublicId: image.publicId, width: 1080, height: 1350, altText: 'Welcome' };
    const put = await request(app).put(url).set(asSuper()).send(body);
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ eventId: id, kind: 'UPLOAD', cloudinaryPublicId: image.publicId });
    const file = await prisma.storedFile.findUniqueOrThrow({ where: { publicId: image.publicId } });
    expect(file).toMatchObject({ kind: 'INVITATION_DESIGN', tenantId: internalTenantId, eventId: id, status: 'ATTACHED' });

    const got = await request(app).get(url).set(asSuper());
    expect(got.status).toBe(200);
    expect(got.body.data.cloudinaryPublicId).toBe(image.publicId);

    // Switching to a template design requests the uploaded image's deletion.
    const toTemplate = await request(app).put(url).set(asSuper()).send(TEMPLATE_DESIGN);
    expect(toTemplate.status).toBe(200);
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { publicId: image.publicId } })).status).toBe('DELETE_REQUESTED');
  }, 30_000);

  it('a tenant gets the same 404 as a missing event on every design and upload route of a template', async () => {
    const created = await createTemplate();
    const id = created.body.data.id as string;
    const url = `/api/events/${id}/invitation-design`;
    const tenant = () => headersFor(tenantAdmin);

    expect((await request(app).get(url).set(tenant())).status).toBe(404);
    expect((await request(app).post(`${url}/upload-signature`).set(tenant()).send({})).status).toBe(404);
    expect((await request(app).put(url).set(tenant()).send(TEMPLATE_DESIGN)).status).toBe(404);
    expect((await request(app).post('/api/uploads/signature').set(tenant()).send({ purpose: 'EVENT_COVER', eventId: id })).status).toBe(404);
    expect((await request(app).get(`/api/events/${id}`).set(tenant())).status).toBe(404);
    expect((await request(app).get('/api/events').set(tenant())).body.data.map((e: { id: string }) => e.id)).not.toContain(id);
  }, 30_000);
});
