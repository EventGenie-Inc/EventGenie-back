import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  MEMORY HUB ROUTES — THE HUB AND ITEM BELONG TO THE URL'S EVENT
//
//  /api/events/:eventId/memory-hub/:id and .../:hubId/items/:id used to
//  gate only on the hub's own event, so a tenant's hub (or item) could be
//  read, edited, archived, shared or curated under any of that tenant's
//  event URLs. Now the URL's event is gated first, the hub must be that
//  event's and the item that hub's: anything else is a 404 (never a 403),
//  and nothing is written. Another tenant's is the same 404.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let outsider: Actor;
let eventA: string; // the URL's event
let hubA: string;
let eventB: string; // the same tenant's other event
let hubB: string;
let itemB: string;
let itemA: string;

const item = (hubId: string, by: string, name: string) =>
  prisma.memoryItem.create({
    data: {
      memoryHubId: hubId,
      uploadedByUserId: by,
      mediaUrl: `https://res.cloudinary.com/demo/image/upload/${name}.jpg`,
      cloudinaryPublicId: name,
      mediaType: 'IMAGE',
      bytes: 1000,
      status: 'PENDING',
      createdBy: by,
      updatedBy: by,
    },
  });

beforeAll(async () => {
  const tenant = await createTenant(); // ELEVATE
  const other = await createTenant();
  tenantIds.push(tenant.id, other.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  outsider = await createActor('TENANT_ADMIN', other.id);
  eventA = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  eventB = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  hubA = (await prisma.memoryHub.findFirstOrThrow({ where: { eventId: eventA } })).id;
  hubB = (await prisma.memoryHub.findFirstOrThrow({ where: { eventId: eventB } })).id;
  itemA = (await item(hubA, organiser.id, 'scope-a')).id;
  itemB = (await item(hubB, organiser.id, 'scope-b')).id;
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await prisma.memoryItem.deleteMany({ where: { memoryHubId: { in: [hubA, hubB] } } });
  await deleteTenantsDeep(tenantIds.splice(0));
  await prisma.$disconnect();
}, 60000);

// Hub B and its item, as stored: equal before and after means nothing written.
const storedB = async () =>
  JSON.stringify({
    hub: await prisma.memoryHub.findUnique({ where: { id: hubB } }),
    items: await prisma.memoryItem.findMany({ where: { memoryHubId: hubB }, orderBy: { id: 'asc' } }),
  });

type Call = [method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object];

// Each route as a builder, so the ids (known only after beforeAll) are
// filled in inside the test.
const HUB_ROUTES: Record<string, (eventId: string, hubId: string) => Call> = {
  'PUT /:id': (e, h) => ['put', `/api/events/${e}/memory-hub/${h}`, { title: 'Hijacked' }],
  'POST /:id/share-link': (e, h) => ['post', `/api/events/${e}/memory-hub/${h}/share-link`],
  'DELETE /:id/share-link': (e, h) => ['delete', `/api/events/${e}/memory-hub/${h}/share-link`],
  'DELETE /:id': (e, h) => ['delete', `/api/events/${e}/memory-hub/${h}`],
  'POST /:id/reactivate': (e, h) => ['post', `/api/events/${e}/memory-hub/${h}/reactivate`],
  'GET /:hubId/items': (e, h) => ['get', `/api/events/${e}/memory-hub/${h}/items`],
  'POST /:hubId/items': (e, h) => [
    'post',
    `/api/events/${e}/memory-hub/${h}/items`,
    { mediaUrl: 'https://res.cloudinary.com/demo/image/upload/x.jpg', cloudinaryPublicId: 'x', mediaType: 'IMAGE', bytes: 10 },
  ],
};

const ITEM_ROUTES: Record<string, (eventId: string, hubId: string, itemId: string) => Call> = {
  'GET /:hubId/items/:id': (e, h, i) => ['get', `/api/events/${e}/memory-hub/${h}/items/${i}`],
  'PUT /:hubId/items/:id': (e, h, i) => ['put', `/api/events/${e}/memory-hub/${h}/items/${i}`, { caption: 'Hijacked' }],
  'POST /:hubId/items/:id/approve': (e, h, i) => ['post', `/api/events/${e}/memory-hub/${h}/items/${i}/approve`],
  'POST /:hubId/items/:id/reject': (e, h, i) => ['post', `/api/events/${e}/memory-hub/${h}/items/${i}/reject`],
  'DELETE /:hubId/items/:id': (e, h, i) => ['delete', `/api/events/${e}/memory-hub/${h}/items/${i}`],
  'POST /:hubId/items/:id/reactivate': (e, h, i) => ['post', `/api/events/${e}/memory-hub/${h}/items/${i}/reactivate`],
};

const send = (actor: Actor, [method, path, body]: Call) => {
  const req = request(app)[method](path).set(headersFor(actor));
  return body ? req.send(body) : req;
};

describe("another event's hub under this event's URL is a 404, and nothing is written", () => {
  for (const [name, route] of Object.entries(HUB_ROUTES)) {
    it(name, async () => {
      const before = await storedB();
      const res = await send(organiser, route(eventA, hubB));
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.message).toBe('Memory hub not found');
      expect(await storedB()).toBe(before);
    }, 60000);
  }
});

describe('an item is reached only under its own hub and event', () => {
  for (const [name, route] of Object.entries(ITEM_ROUTES)) {
    it(`${name}: another event's hub and item`, async () => {
      const before = await storedB();
      const res = await send(organiser, route(eventA, hubB, itemB));
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Memory hub not found');
      expect(await storedB()).toBe(before);
    }, 60000);

    it(`${name}: this event's hub, another hub's item`, async () => {
      const before = await storedB();
      const res = await send(organiser, route(eventA, hubA, itemB));
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Memory item not found');
      expect(await storedB()).toBe(before);
    }, 60000);
  }
});

describe('the same routes', () => {
  it("are a 404 for another tenant's organiser, under the hub's own URL", async () => {
    const before = await storedB();
    const calls = [
      ...Object.entries(HUB_ROUTES).map(([name, route]) => [name, route(eventB, hubB)] as const),
      ...Object.entries(ITEM_ROUTES).map(([name, route]) => [name, route(eventB, hubB, itemB)] as const),
    ];
    for (const [name, call] of calls) {
      const res = await send(outsider, call);
      expect(res.status, name).toBe(404);
    }
    expect(await storedB()).toBe(before);
  }, 120000);

  it('still work under the right URL', async () => {
    const h = headersFor(organiser);
    const put = await request(app).put(`/api/events/${eventA}/memory-hub/${hubA}`).set(h).send({ title: 'Our album' });
    expect(put.status).toBe(200);
    expect(put.body.data.title).toBe('Our album');
    const list = await request(app).get(`/api/events/${eventA}/memory-hub/${hubA}/items`).set(h);
    expect(list.status).toBe(200);
    expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([itemA]);
    const approve = await request(app).post(`/api/events/${eventA}/memory-hub/${hubA}/items/${itemA}/approve`).set(h);
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('APPROVED');
  }, 60000);
});
