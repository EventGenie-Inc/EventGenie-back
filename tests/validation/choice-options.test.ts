import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  CHOICE QUESTIONS' OPTIONS (DROPDOWN, "Multiple choice", and MULTI_SELECT)
//
//  When such a question is saved (created on POST .../rsvp-fields, the full
//  update or the wizard's materialize; or changed on PUT .../rsvp-fields/:id
//  or the full update, its type made a choice one or its options changed):
//  no blank option (RSVP_FIELD_OPTION_BLANK), no option twice, trimmed and
//  ignoring case (RSVP_FIELD_OPTION_DUPLICATE), at least two
//  (RSVP_FIELD_OPTIONS_TOO_FEW), each message naming the question, nothing
//  written. A question saved before the rule keeps its options and still
//  saves when re-sent as it is or edited elsewhere.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let eventId: string;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventId = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  await prisma.event.update({ where: { id: eventId }, data: { hostName: 'Durban Chess Club' } });
}, 60000);

afterAll(async () => {
  await deleteTenantsDeep(tenantIds);
}, 120000);

beforeEach(() => installFirebaseMock());

const h = () => headersFor(organiser);
const LABEL = 'T-shirt size';

// Each rule: options that break it, its code and message.
const RULES = [
  { rule: 'a blank option', options: ['S', '  ', 'M'], code: 'RSVP_FIELD_OPTION_BLANK', message: `Each option for '${LABEL}' needs text. Remove the blank one.` },
  { rule: 'an empty option', options: ['S', '', 'M'], code: 'RSVP_FIELD_OPTION_BLANK', message: `Each option for '${LABEL}' needs text. Remove the blank one.` },
  { rule: 'a duplicate, ignoring case and spaces', options: ['Small', 'Large', ' small '], code: 'RSVP_FIELD_OPTION_DUPLICATE', message: `'${LABEL}' has the option 'small' more than once.` },
  { rule: 'one option', options: ['One size'], code: 'RSVP_FIELD_OPTIONS_TOO_FEW', message: `'${LABEL}' needs at least 2 options.` },
  { rule: 'no options (an empty list)', options: [], code: 'RSVP_FIELD_OPTIONS_TOO_FEW', message: `'${LABEL}' needs at least 2 options.` },
] as const;

const storedFields = async () =>
  JSON.stringify(await prisma.rsvpField.findMany({ where: { eventId }, orderBy: { id: 'asc' }, select: { id: true, fieldType: true, options: true, label: true } }));

const newField = async (fieldType: 'DROPDOWN' | 'MULTI_SELECT' | 'TEXT', options: string | null, label = LABEL) =>
  prisma.rsvpField.create({ data: { eventId, label, fieldType, options, order: 9, createdBy: organiser.id, updatedBy: organiser.id } });

for (const fieldType of ['DROPDOWN', 'MULTI_SELECT'] as const) {
  describe(`${fieldType} options`, () => {
    for (const { rule, options, code, message } of RULES) {
      it(`${rule}: 422 ${code} on create, update and the full update; nothing written`, async () => {
        const json = JSON.stringify(options);
        const saved = await newField(fieldType, '["S","M"]');
        const text = await newField('TEXT', null, 'Shirt note');
        const before = await storedFields();

        const create = await request(app).post(`/api/events/${eventId}/rsvp-fields`).set(h()).send({ label: LABEL, fieldType, options: json, order: 1 });
        expect(create.status, JSON.stringify(create.body)).toBe(422);
        expect(create.body).toMatchObject({ code, message });

        // Changing a saved choice question's options.
        const update = await request(app).put(`/api/events/${eventId}/rsvp-fields/${saved.id}`).set(h()).send({ options: json });
        expect(update.status).toBe(422);
        expect(update.body).toMatchObject({ code, message });

        // Making a text question a choice one with these options (the
        // message names the question being saved).
        const toChoice = await request(app).put(`/api/events/${eventId}/rsvp-fields/${text.id}`).set(h()).send({ fieldType, options: json });
        expect(toChoice.status).toBe(422);
        expect(toChoice.body).toMatchObject({ code, message: message.replace(LABEL, 'Shirt note') });

        // The full update: a new question, and a change to a saved one.
        const fullNew = await request(app).put(`/api/events/${eventId}/full`).set(h())
          .send({ rsvpFields: [{ id: saved.id }, { id: text.id }, { label: LABEL, fieldType, options: json }] });
        expect(fullNew.status).toBe(422);
        expect(fullNew.body).toMatchObject({ code, message });
        const fullChange = await request(app).put(`/api/events/${eventId}/full`).set(h())
          .send({ rsvpFields: [{ id: saved.id, options: json }, { id: text.id }] });
        expect(fullChange.status).toBe(422);
        expect(fullChange.body).toMatchObject({ code, message });

        expect(await storedFields()).toBe(before);
        await prisma.rsvpField.deleteMany({ where: { id: { in: [saved.id, text.id] } } });
      }, 60000);
    }

    it('two or more distinct, non-blank options are saved as sent, on every path', async () => {
      const create = await request(app).post(`/api/events/${eventId}/rsvp-fields`).set(h())
        .send({ label: LABEL, fieldType, options: '["Small","Large, roomy"]', order: 1 });
      expect(create.status, JSON.stringify(create.body)).toBe(201);
      expect(create.body.data.options).toBe('["Small","Large, roomy"]');
      const update = await request(app).put(`/api/events/${eventId}/rsvp-fields/${create.body.data.id}`).set(h())
        .send({ options: '["Small","Medium","Large, roomy"]' });
      expect(update.status).toBe(200);
      const full = await request(app).put(`/api/events/${eventId}/full`).set(h())
        .send({ rsvpFields: [{ id: create.body.data.id }, { label: 'Sessions', fieldType, options: '["Morning","Afternoon"]' }] });
      expect(full.status, JSON.stringify(full.body)).toBe(200);
      await prisma.rsvpField.deleteMany({ where: { eventId } });
    }, 60000);

    it('a question saved before the rule keeps its options, and re-sent as it is or edited elsewhere still saves', async () => {
      for (const legacy of ['["Only"]', '["Yes","yes"]', '["A",""]', null]) {
        const saved = await newField(fieldType, legacy);
        // Its label, required flag and order change; its options are untouched.
        const put = await request(app).put(`/api/events/${eventId}/rsvp-fields/${saved.id}`).set(h())
          .send({ label: 'Renamed', isRequired: true, fieldType, ...(legacy !== null && { options: legacy }) });
        expect(put.status, `${legacy} ${JSON.stringify(put.body)}`).toBe(200);
        const full = await request(app).put(`/api/events/${eventId}/full`).set(h())
          .send({ rsvpFields: [{ id: saved.id, label: 'Renamed again', fieldType, options: legacy }] });
        expect(full.status, `${legacy} ${JSON.stringify(full.body)}`).toBe(200);
        expect((await prisma.rsvpField.findUniqueOrThrow({ where: { id: saved.id } })).options).toBe(legacy);
        await prisma.rsvpField.delete({ where: { id: saved.id } });
      }
    }, 90000);
  });
}

describe('other answer types', () => {
  it('are not held to the choice rules', async () => {
    const res = await request(app).post(`/api/events/${eventId}/rsvp-fields`).set(h())
      .send({ label: 'Notes', fieldType: 'TEXT', options: '["Only"]', order: 1 });
    expect(res.status).toBe(201);
    await prisma.rsvpField.deleteMany({ where: { eventId } });
  }, 60000);
});

describe("the wizard's materialize", () => {
  const materializeWith = async (fieldType: string, options: unknown) => {
    await eventDraftRepository.upsert(organiser.tenantId!, organiser.id, {
      currentStep: 3,
      payload: {
        name: 'Choice options draft',
        hostName: 'Test Host',
        days: [{ label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Main Rd' }],
        customFields: [{ label: LABEL, fieldType, isRequired: false, options }],
      },
    });
    return eventDraftService.materialize(organiser.tenantId!, organiser.id);
  };
  const eventCount = () => prisma.event.count({ where: { tenantId: organiser.tenantId! } });

  for (const fieldType of ['DROPDOWN', 'MULTI_SELECT']) {
    it(`${fieldType}: each rule refused with its code, no event created; valid options create it`, async () => {
      for (const { options, code, message } of [...RULES, { options: undefined, code: 'RSVP_FIELD_OPTIONS_TOO_FEW', message: `'${LABEL}' needs at least 2 options.` }]) {
        const before = await eventCount();
        await expect(materializeWith(fieldType, options)).rejects.toMatchObject({ statusCode: 422, code, message });
        expect(await eventCount()).toBe(before);
      }
      const event = await materializeWith(fieldType, ['S', 'M']);
      expect((await prisma.rsvpField.findFirstOrThrow({ where: { eventId: event!.id } })).options).toBe('["S","M"]');
    }, 120000);
  }
});
