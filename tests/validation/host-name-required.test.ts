import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import {
  EVENT_HOST_NAME_REQUIRED,
  EVENT_HOST_NAME_REQUIRED_MESSAGE,
} from '../../src/modules/event/event-host-name.util.js';
import {
  createTenant,
  createActor,
  installFirebaseMock,
  headersFor,
  createEventWithDay,
  deleteTenantsDeep,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  EVERY EVENT HAS A HOST NAME — event create, PUT /api/events/:id, the full
//  update and the wizard's materialize. Missing, null or blank (after
//  trimming) is 422 EVENT_HOST_NAME_REQUIRED and nothing is written. An
//  older event saved without one keeps none until it is next edited; that
//  edit must supply it.
// ─────────────────────────────────────────

const REQUIRED = { status: 'error', message: EVENT_HOST_NAME_REQUIRED_MESSAGE, code: EVENT_HOST_NAME_REQUIRED };
const BLANKS: { name: string; value?: unknown }[] = [{ name: 'missing' }, { name: 'null', value: null }, { name: 'blank', value: '   ' }];
const withHost = (body: Record<string, unknown>, blank: { value?: unknown }) =>
  'value' in blank ? { ...body, hostName: blank.value } : body;

const tenantIds: string[] = [];
let owner: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  owner = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

beforeEach(() => installFirebaseMock());

afterEach(async () => {
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: owner.id } });
});

afterAll(async () => {
  await deleteTenantsDeep(tenantIds);
}, 120000);

const eventCount = () => prisma.event.count({ where: { tenantId: owner.tenantId! } });

// An event as it was before host names were required: none stored.
const olderEvent = async () => {
  const { event, day } = await createEventWithDay(owner.tenantId!, owner.id);
  expect(event.hostName).toBeNull();
  return { eventId: event.id, dayId: day.id };
};

describe('POST /api/events', () => {
  for (const blank of BLANKS) {
    it(`${blank.name}: 422 ${EVENT_HOST_NAME_REQUIRED}, no event created`, async () => {
      const before = await eventCount();
      const res = await request(app).post('/api/events').set(headersFor(owner)).send(withHost({ name: 'Year-end function' }, blank));
      expect(res.status).toBe(422);
      expect(res.body).toEqual(REQUIRED);
      expect(await eventCount()).toBe(before);
    }, 60000);
  }

  it('a host name creates the event, trimmed', async () => {
    const res = await request(app).post('/api/events').set(headersFor(owner)).send({ name: 'Year-end function', hostName: '  Acme HR ' });
    expect(res.status).toBe(201);
    expect(res.body.data.hostName).toBe('Acme HR');
  }, 60000);
});

describe('PUT /api/events/:id', () => {
  it('an older event with no host name: an edit without one is refused and changes nothing; with one it saves', async () => {
    const { eventId } = await olderEvent();

    for (const blank of BLANKS) {
      const res = await request(app).put(`/api/events/${eventId}`).set(headersFor(owner)).send(withHost({ name: 'Renamed' }, blank));
      expect(res.status, blank.name).toBe(422);
      expect(res.body).toEqual(REQUIRED);
    }
    const row = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(row).toMatchObject({ hostName: null, name: expect.not.stringMatching(/^Renamed$/) });

    const ok = await request(app).put(`/api/events/${eventId}`).set(headersFor(owner)).send({ name: 'Renamed', hostName: 'Acme HR' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Renamed', hostName: 'Acme HR' });
  }, 60000);

  it('an event that has one: an edit that leaves it out keeps it; clearing it is refused', async () => {
    const { eventId } = await olderEvent();
    await prisma.event.update({ where: { id: eventId }, data: { hostName: 'Acme HR' } });

    const ok = await request(app).put(`/api/events/${eventId}`).set(headersFor(owner)).send({ name: 'Renamed again' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.hostName).toBe('Acme HR');

    const cleared = await request(app).put(`/api/events/${eventId}`).set(headersFor(owner)).send({ hostName: '' });
    expect(cleared.status).toBe(422);
    expect(cleared.body).toEqual(REQUIRED);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).hostName).toBe('Acme HR');
  }, 60000);
});

describe('PUT /api/events/:id/full', () => {
  it('an older event with no host name: a save without one is refused and writes nothing, even one touching only a day', async () => {
    const { eventId, dayId } = await olderEvent();
    const day = { id: dayId, label: 'Renamed day' };

    for (const blank of BLANKS) {
      const res = await request(app)
        .put(`/api/events/${eventId}/full`)
        .set(headersFor(owner))
        .send({ event: withHost({ name: 'Renamed' }, blank), days: [day] });
      expect(res.status, blank.name).toBe(422);
      expect(res.body).toEqual(REQUIRED);
    }
    const daysOnly = await request(app).put(`/api/events/${eventId}/full`).set(headersFor(owner)).send({ days: [day] });
    expect(daysOnly.status).toBe(422);
    expect(daysOnly.body).toEqual(REQUIRED);
    expect((await prisma.eventDay.findUniqueOrThrow({ where: { id: dayId } })).label).toBe('Day 1');
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).hostName).toBeNull();

    const ok = await request(app)
      .put(`/api/events/${eventId}/full`)
      .set(headersFor(owner))
      .send({ event: { name: 'Renamed', hostName: ' Acme HR ' }, days: [day] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.hostName).toBe('Acme HR');
  }, 60000);

  it('an event that has one: a save that leaves it out keeps it', async () => {
    const { eventId } = await olderEvent();
    await prisma.event.update({ where: { id: eventId }, data: { hostName: 'Acme HR' } });
    const res = await request(app).put(`/api/events/${eventId}/full`).set(headersFor(owner)).send({ event: { name: 'Renamed' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.hostName).toBe('Acme HR');
  }, 60000);
});

describe("the wizard's materialize", () => {
  const draft = (extra: Record<string, unknown>) =>
    eventDraftRepository.upsert(owner.tenantId!, owner.id, {
      currentStep: 4,
      payload: { name: 'Wizard event', days: [{ label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Road' }], ...extra },
    });

  for (const blank of BLANKS) {
    it(`${blank.name}: 422 ${EVENT_HOST_NAME_REQUIRED}, no event created, the draft kept`, async () => {
      const before = await eventCount();
      await draft(withHost({}, blank));
      await expect(eventDraftService.materialize(owner.tenantId!, owner.id)).rejects.toMatchObject({
        statusCode: 422,
        code: EVENT_HOST_NAME_REQUIRED,
      });
      expect(await eventCount()).toBe(before);
      expect(await eventDraftRepository.findByTenantAndUser(owner.tenantId!, owner.id)).not.toBeNull();
    }, 60000);
  }

  it('a host name creates the event', async () => {
    await draft({ hostName: 'Acme HR' });
    const event = await eventDraftService.materialize(owner.tenantId!, owner.id);
    expect(event!.hostName).toBe('Acme HR');
  }, 60000);
});
