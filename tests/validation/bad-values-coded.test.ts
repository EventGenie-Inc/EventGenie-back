import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
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
//  BAD VALUES ARE A CODED 422, NEVER A 500
//
//  Three values used to reach Prisma unchecked and come back a 500:
//  - a custom question's `options` (not a JSON list of text choices):
//    422 RSVP_FIELD_OPTIONS_INVALID, on POST/PUT .../rsvp-fields and the
//    full event update;
//  - the Memory Hub's `opensAt` (not a date): 422
//    MEMORY_HUB_OPENS_AT_INVALID, on POST/PUT .../memory-hub, the full
//    update and the wizard's materialize;
//  - a program's `isPublished` (not true/false): 422
//    PROGRAM_VISIBILITY_INVALID, on PUT .../program/:id (materialize and the
//    full update already refused it; now with the code too).
//  Nothing is written by any refusal. The fixtures' plan (ELEVATE) has
//  custom questions in the test database's tier row.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let eventId: string;
let hubId: string;
let programId: string;
let fieldId: string;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventId = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  hubId = (await prisma.memoryHub.findFirstOrThrow({ where: { eventId } })).id;
  programId = (await prisma.eventProgram.create({ data: { eventId, createdBy: organiser.id, updatedBy: organiser.id } })).id;
  fieldId = (
    await prisma.rsvpField.create({
      data: { eventId, label: 'Shirt size', fieldType: 'DROPDOWN', options: '["S","M"]', order: 0, createdBy: organiser.id, updatedBy: organiser.id },
    })
  ).id;
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: organiser.id } });
  await deleteTenantsDeep(tenantIds.splice(0));
  await prisma.$disconnect();
}, 60000);

const h = () => headersFor(organiser);
const stored = async () =>
  JSON.stringify({
    fields: await prisma.rsvpField.findMany({ where: { eventId }, orderBy: { id: 'asc' } }),
    hub: await prisma.memoryHub.findUnique({ where: { id: hubId } }),
    program: await prisma.eventProgram.findUnique({ where: { id: programId } }),
    event: await prisma.event.findUnique({ where: { id: eventId } }),
  });

const BAD_OPTIONS: [string, unknown][] = [
  ['a list, not its JSON', ['S', 'M']],
  ['not JSON', 'S, M, L'],
  ['JSON that is not a list', '{"S":1}'],
  ['a list with a non-text choice', '["S",2]'],
  ['a number', 7],
];

describe('custom question options', () => {
  for (const [name, options] of BAD_OPTIONS) {
    it(`${name}: 422 RSVP_FIELD_OPTIONS_INVALID on create, update and the full update; nothing written`, async () => {
      const before = await stored();
      const create = await request(app).post(`/api/events/${eventId}/rsvp-fields`).set(h()).send({ label: 'Pick', fieldType: 'DROPDOWN', options, order: 1 });
      expect(create.status, JSON.stringify(create.body)).toBe(422);
      expect(create.body.code).toBe('RSVP_FIELD_OPTIONS_INVALID');
      const update = await request(app).put(`/api/events/${eventId}/rsvp-fields/${fieldId}`).set(h()).send({ options });
      expect(update.status).toBe(422);
      expect(update.body.code).toBe('RSVP_FIELD_OPTIONS_INVALID');
      const full = await request(app).put(`/api/events/${eventId}/full`).set(h()).send({ rsvpFields: [{ id: fieldId, options }] });
      expect(full.status).toBe(422);
      expect(full.body.code).toBe('RSVP_FIELD_OPTIONS_INVALID');
      expect(await stored()).toBe(before);
    }, 60000);
  }

  it('a JSON list of choices, or none, is saved', async () => {
    const list = await request(app).post(`/api/events/${eventId}/rsvp-fields`).set(h()).send({ label: 'Colour', fieldType: 'DROPDOWN', options: '["Red","Blue"]', order: 1 });
    expect(list.status).toBe(201);
    expect(list.body.data.options).toBe('["Red","Blue"]');
    const none = await request(app).post(`/api/events/${eventId}/rsvp-fields`).set(h()).send({ label: 'Notes', fieldType: 'TEXT', options: null, order: 2 });
    expect(none.status).toBe(201);
  }, 60000);
});

describe("the wizard's draft question options", () => {
  // The draft holds options as a list (the frontend's draft model); it is
  // stored as its JSON, and anything that isn't a list of text is refused
  // with the other paths' code, with no event created.
  const materializeWith = async (options: unknown) => {
    await eventDraftRepository.upsert(organiser.tenantId!, organiser.id, {
      currentStep: 3,
      payload: {
        name: 'Options draft',
        hostName: 'Test Host',
        days: [{ label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Main Rd' }],
        customFields: [{ label: 'Shirt size', fieldType: 'DROPDOWN', isRequired: false, options }],
      },
    });
    return eventDraftService.materialize(organiser.tenantId!, organiser.id);
  };
  const eventCount = () => prisma.event.count({ where: { tenantId: organiser.tenantId! } });

  for (const [name, options] of [
    ['a list with a non-text choice', ['S', 2]],
    ['text that is not a JSON list', 'S, M, L'],
    ['an object', { S: 1 }],
    ['a number', 3],
  ] as const) {
    it(`${name}: 422 RSVP_FIELD_OPTIONS_INVALID, no event created`, async () => {
      const before = await eventCount();
      await expect(materializeWith(options)).rejects.toMatchObject({ statusCode: 422, code: 'RSVP_FIELD_OPTIONS_INVALID' });
      expect(await eventCount()).toBe(before);
    }, 60000);
  }

  it('a list of choices is stored as its JSON, a JSON string as it is, and none as null', async () => {
    for (const [options, stored] of [
      [['S', 'M'], '["S","M"]'],
      ['["L"]', '["L"]'],
      [undefined, null],
    ] as const) {
      const event = await materializeWith(options);
      const field = await prisma.rsvpField.findFirstOrThrow({ where: { eventId: event!.id } });
      expect(field.options).toBe(stored);
    }
  }, 120000);
});

describe("the Memory Hub's opening time", () => {
  for (const [name, opensAt] of [['not a date', 'next Friday'], ['a number', 1767225600000], ['spaces', '   ']] as const) {
    it(`${name}: 422 MEMORY_HUB_OPENS_AT_INVALID on update and the full update; nothing written`, async () => {
      const before = await stored();
      const update = await request(app).put(`/api/events/${eventId}/memory-hub/${hubId}`).set(h()).send({ opensAt });
      expect(update.status, JSON.stringify(update.body)).toBe(422);
      expect(update.body.code).toBe('MEMORY_HUB_OPENS_AT_INVALID');
      const full = await request(app).put(`/api/events/${eventId}/full`).set(h()).send({ event: { name: 'Changed' }, memoryHub: { opensAt } });
      expect(full.status).toBe(422);
      expect(full.body.code).toBe('MEMORY_HUB_OPENS_AT_INVALID');
      expect(await stored()).toBe(before);
    }, 60000);
  }

  it('on create, the bad value is refused before the "already exists" 409', async () => {
    const res = await request(app).post(`/api/events/${eventId}/memory-hub`).set(h()).send({ opensAt: 'soon' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MEMORY_HUB_OPENS_AT_INVALID');
  }, 60000);

  it('the wizard refuses it too', async () => {
    await eventDraftRepository.upsert(organiser.tenantId!, organiser.id, {
      currentStep: 3,
      payload: { name: 'Album draft', hostName: 'Test Host', days: [{ label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Main Rd' }], memoryHub: { opensAt: 'whenever' } },
    });
    await expect(eventDraftService.materialize(organiser.tenantId!, organiser.id)).rejects.toMatchObject({ statusCode: 422, code: 'MEMORY_HUB_OPENS_AT_INVALID' });
  }, 60000);

  it('a date, or null or empty for open now, is saved', async () => {
    const date = await request(app).put(`/api/events/${eventId}/memory-hub/${hubId}`).set(h()).send({ opensAt: '2030-03-02T18:00:00' });
    expect(date.status).toBe(200);
    expect(date.body.data.opensAt).toBe('2030-03-02T18:00:00.000Z');
    for (const opensAt of [null, '']) {
      const open = await request(app).put(`/api/events/${eventId}/memory-hub/${hubId}`).set(h()).send({ opensAt });
      expect(open.status).toBe(200);
      expect(open.body.data.opensAt).toBeNull();
    }
  }, 60000);
});

describe("a program's visibility", () => {
  it('not true or false: 422 PROGRAM_VISIBILITY_INVALID on PUT .../program/:id and the full update; nothing written', async () => {
    const before = await stored();
    const put = await request(app).put(`/api/events/${eventId}/program/${programId}`).set(h()).send({ isPublished: 'no' });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect(put.body.code).toBe('PROGRAM_VISIBILITY_INVALID');
    const full = await request(app).put(`/api/events/${eventId}/full`).set(h()).send({ program: { isPublished: 'no' } });
    expect(full.status).toBe(422);
    expect(full.body.code).toBe('PROGRAM_VISIBILITY_INVALID');
    expect(await stored()).toBe(before);

    const ok = await request(app).put(`/api/events/${eventId}/program/${programId}`).set(h()).send({ isPublished: false });
    expect(ok.status).toBe(200);
    expect(ok.body.data.isPublished).toBe(false);
  }, 60000);
});
