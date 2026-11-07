import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import app from '../../src/app.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, view, prisma, type PublicEventFixture } from './helpers.js';

// ─────────────────────────────────────────
//  MULTI_SELECT QUESTIONS
//
//  Options stored as a DROPDOWN's are (a JSON-encoded list, so an option
//  can hold a comma). The answer is a list of chosen options, sent as
//  rsvpResponses: [{ rsvpFieldId, value: ['Vegan', 'Halaal'] }] at RSVP
//  submit and at public registration, each choice one of the options and
//  none twice; required means at least one chosen. Stored as a JSON list,
//  read back as a list (the guest's page, the submit response, the
//  organiser's guest details), exported joined with "; ". Once answered,
//  a question can't change to or from MULTI_SELECT (RSVP_FIELD_TYPE_LOCKED).
// ─────────────────────────────────────────

beforeEach(() => installFirebaseMock());

afterEach(async () => {
  await cleanupPublicEventFixtures();
});

const OPTIONS = ['Vegan', 'Halaal', 'Nuts, peanuts and tree nuts'];

const addQuestions = async (ev: PublicEventFixture, opts: { required?: boolean } = {}) => {
  const by = ev.organiser.id;
  const diet = await prisma.rsvpField.create({
    data: {
      eventId: ev.eventId, label: 'Dietary needs', fieldType: 'MULTI_SELECT', isRequired: opts.required ?? false,
      options: JSON.stringify(OPTIONS), order: 0, createdBy: by, updatedBy: by,
    },
  });
  const note = await prisma.rsvpField.create({
    data: { eventId: ev.eventId, label: 'Note', fieldType: 'TEXT', isRequired: false, order: 1, createdBy: by, updatedBy: by },
  });
  return { diet, note };
};

const registrantsOf = (eventId: string) =>
  prisma.guest.findMany({ where: { eventId, selfRegisteredAt: { not: null } }, include: { invites: { include: { rsvpResponses: true } } } });

const rsvpFor = (ev: PublicEventFixture, token: string) => (body: Record<string, unknown>) =>
  request(app).post('/api/rsvp/submit').send({ token, attending: true, firstName: 'Lebo', attendingDayIds: [ev.dayIds[0]], ...body });

const exportValues = async (ev: PublicEventFixture): Promise<string[]> => {
  const { buffer } = await guestService.exportGuests(ev.eventId, 'TENANT_ADMIN', ev.tenantId);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const values: string[] = [];
  workbook.getWorksheet('Guests')!.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value))));
  return values;
};

describe('answering a MULTI_SELECT question', () => {
  it('the public view and the RSVP page get the question with its options as a DROPDOWN’s', async () => {
    const ev = await createPublicEvent();
    const { diet } = await addQuestions(ev);
    const res = await view(ev.shareToken);
    expect(res.body.data.rsvpFields[0]).toEqual({
      id: diet.id, label: 'Dietary needs', description: null, fieldType: 'MULTI_SELECT', isRequired: false, options: JSON.stringify(OPTIONS),
    });
  }, 60000);

  it('at RSVP: stored as a list, returned as a list by submit, the guest’s page and the guest details; exported joined with "; "', async () => {
    const ev = await createPublicEvent();
    const { diet, note } = await addQuestions(ev);
    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    const chosen = ['Halaal', ' Nuts, peanuts and tree nuts '];

    const res = await rsvpFor(ev, invite.token)({
      rsvpResponses: [{ rsvpFieldId: diet.id, value: chosen }, { rsvpFieldId: note.id, value: 'Window seat' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const trimmed = ['Halaal', 'Nuts, peanuts and tree nuts'];
    expect(res.body.data.rsvpResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({ rsvpFieldId: diet.id, value: trimmed }),
      expect.objectContaining({ rsvpFieldId: note.id, value: 'Window seat' }),
    ]));

    // Stored: the JSON list of trimmed choices, in the order chosen.
    const stored = await prisma.rsvpResponse.findFirstOrThrow({ where: { inviteId: invite.id, rsvpFieldId: diet.id } });
    expect(stored.value).toBe(JSON.stringify(trimmed));

    // The guest's page prefills from a list, the shape it sends.
    const page = await request(app).get(`/api/rsvp/validate/${invite.token}`);
    expect(page.body.data.rsvpResponses).toEqual(expect.arrayContaining([
      { rsvpFieldId: diet.id, value: trimmed },
      { rsvpFieldId: note.id, value: 'Window seat' },
    ]));

    // The organiser's guest details: the list; other answers unchanged.
    const details = await request(app).get(`/api/invites/${invite.id}/rsvp-responses`).set(headersFor(ev.organiser));
    expect(details.status).toBe(200);
    const byField = new Map(details.body.data.map((r: { rsvpFieldId: string; value: unknown }) => [r.rsvpFieldId, r.value]));
    expect(byField.get(diet.id)).toEqual(trimmed);
    expect(byField.get(note.id)).toBe('Window seat');
    const one = await request(app)
      .get(`/api/invites/${invite.id}/rsvp-responses/${stored.id}`)
      .set(headersFor(ev.organiser));
    expect(one.body.data.value).toEqual(trimmed);

    // The export: one cell, choices joined with "; " (an option has a comma).
    expect(await exportValues(ev)).toEqual(expect.arrayContaining(['Dietary needs', 'Halaal; Nuts, peanuts and tree nuts', 'Window seat']));

    // An edit replaces the list; an empty list stores no answer.
    expect((await rsvpFor(ev, invite.token)({ rsvpResponses: [{ rsvpFieldId: diet.id, value: ['Vegan'] }] })).status).toBe(200);
    expect((await prisma.rsvpResponse.findFirstOrThrow({ where: { inviteId: invite.id, rsvpFieldId: diet.id } })).value).toBe('["Vegan"]');
    const cleared = await rsvpFor(ev, invite.token)({ rsvpResponses: [{ rsvpFieldId: diet.id, value: [] }] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.rsvpResponses).toEqual([expect.objectContaining({ rsvpFieldId: diet.id, value: [] })]);
    expect((await prisma.rsvpResponse.findFirstOrThrow({ where: { inviteId: invite.id, rsvpFieldId: diet.id } })).value).toBe('');
  }, 120000);

  it('at registration: stored as a list on the registrant’s invite, shown as a list in the guest details', async () => {
    const ev = await createPublicEvent();
    const { diet } = await addQuestions(ev);
    const res = await register(ev.shareToken, { rsvpResponses: [{ rsvpFieldId: diet.id, value: ['Vegan', 'Halaal'] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [registrant] = await registrantsOf(ev.eventId);
    const invite = registrant!.invites[0]!;
    expect(invite.rsvpResponses.find((r) => r.rsvpFieldId === diet.id)!.value).toBe('["Vegan","Halaal"]');

    const details = await request(app).get(`/api/invites/${invite.id}/rsvp-responses`).set(headersFor(ev.organiser));
    expect(details.body.data.find((r: { rsvpFieldId: string }) => r.rsvpFieldId === diet.id).value).toEqual(['Vegan', 'Halaal']);
    expect(await exportValues(ev)).toEqual(expect.arrayContaining(['Vegan; Halaal']));
  }, 90000);

  it('an option that isn’t one of the question’s is 422 RSVP_ANSWER_UNKNOWN_OPTION, at registration and at RSVP alike', async () => {
    const ev = await createPublicEvent();
    const { diet } = await addQuestions(ev);
    const expected = { message: "Choose only from the options for 'Dietary needs'.", code: 'RSVP_ANSWER_UNKNOWN_OPTION' };
    // A part of a comma-holding option is not an option.
    for (const value of [['Vegan', 'Kosher'], ['Nuts'], ['']]) {
      const answers = [{ rsvpFieldId: diet.id, value }];
      const reg = await register(ev.shareToken, { rsvpResponses: answers });
      expect(reg.status, JSON.stringify(value)).toBe(422);
      expect(reg.body).toMatchObject(expected);
      const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
      const rsvp = await rsvpFor(ev, invite.token)({ rsvpResponses: answers });
      expect(rsvp.status, JSON.stringify(value)).toBe(422);
      expect(rsvp.body).toMatchObject(expected);
    }
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);
  }, 120000);

  it('the same option twice is 422 RSVP_ANSWER_INVALID, at registration and at RSVP alike', async () => {
    const ev = await createPublicEvent();
    const { diet } = await addQuestions(ev);
    const expected = { message: "Choose each option for 'Dietary needs' only once.", code: 'RSVP_ANSWER_INVALID' };
    const answers = [{ rsvpFieldId: diet.id, value: ['Vegan', ' Vegan'] }];
    const reg = await register(ev.shareToken, { rsvpResponses: answers });
    expect(reg.status).toBe(422);
    expect(reg.body).toMatchObject(expected);
    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    const rsvp = await rsvpFor(ev, invite.token)({ rsvpResponses: answers });
    expect(rsvp.status).toBe(422);
    expect(rsvp.body).toMatchObject(expected);
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);
  }, 90000);

  it('required: nothing chosen is 422 RSVP_ANSWER_NONE_CHOSEN when attending, at registration and at RSVP; a decline needs none', async () => {
    const ev = await createPublicEvent();
    const { diet } = await addQuestions(ev, { required: true });
    const expected = {
      message: "Please choose at least one option for 'Dietary needs'. The organiser needs this to plan for you.",
      code: 'RSVP_ANSWER_NONE_CHOSEN',
    };
    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    for (const rsvpResponses of [undefined, [{ rsvpFieldId: diet.id, value: [] }]]) {
      const reg = await register(ev.shareToken, { rsvpResponses });
      expect(reg.status, JSON.stringify(rsvpResponses)).toBe(422);
      expect(reg.body).toMatchObject(expected);
      const rsvp = await rsvpFor(ev, invite.token)({ rsvpResponses });
      expect(rsvp.status, JSON.stringify(rsvpResponses)).toBe(422);
      expect(rsvp.body).toMatchObject(expected);
    }
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);

    const decline = await request(app).post('/api/rsvp/submit').send({ token: invite.token, attending: false, rsvpResponses: [{ rsvpFieldId: diet.id, value: [] }] });
    expect(decline.status, JSON.stringify(decline.body)).toBe(200);
    expect((await rsvpFor(ev, invite.token)({ rsvpResponses: [{ rsvpFieldId: diet.id, value: ['Vegan'] }] })).status).toBe(200);
  }, 120000);

  it('text for a MULTI_SELECT question, or a list for any other, is 422 RSVP_ANSWER_INVALID; a list of non-text is the generic 400', async () => {
    const ev = await createPublicEvent();
    const { diet, note } = await addQuestions(ev);
    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    const cases = [
      { answers: [{ rsvpFieldId: diet.id, value: 'Vegan' }], message: "Choose one or more of the options for 'Dietary needs'." },
      { answers: [{ rsvpFieldId: note.id, value: ['Hello'] }], message: "Give one answer for 'Note'." },
    ];
    for (const { answers, message } of cases) {
      const reg = await register(ev.shareToken, { rsvpResponses: answers });
      expect(reg.status, message).toBe(422);
      expect(reg.body).toMatchObject({ message, code: 'RSVP_ANSWER_INVALID' });
      const rsvp = await rsvpFor(ev, invite.token)({ rsvpResponses: answers });
      expect(rsvp.status, message).toBe(422);
      expect(rsvp.body).toMatchObject({ message, code: 'RSVP_ANSWER_INVALID' });
    }

    const malformed = [{ rsvpFieldId: diet.id, value: ['Vegan', 3] }];
    expect((await register(ev.shareToken, { rsvpResponses: malformed })).status).toBe(400);
    expect((await rsvpFor(ev, invite.token)({ rsvpResponses: malformed })).status).toBe(400);
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe('PENDING');
  }, 120000);
});

describe('saving a MULTI_SELECT question', () => {
  it('is accepted by POST .../rsvp-fields and the full update, with its options as a DROPDOWN’s', async () => {
    const ev = await createPublicEvent({ event: { hostName: 'Durban Chess Club' } });
    const created = await request(app)
      .post(`/api/events/${ev.eventId}/rsvp-fields`)
      .set(headersFor(ev.organiser))
      .send({ label: 'Dietary needs', fieldType: 'MULTI_SELECT', isRequired: true, options: JSON.stringify(OPTIONS), order: 0 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ fieldType: 'MULTI_SELECT', options: JSON.stringify(OPTIONS) });

    const full = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(headersFor(ev.organiser))
      .send({
        rsvpFields: [
          { id: created.body.data.id, label: 'Dietary needs', fieldType: 'MULTI_SELECT', isRequired: true, options: JSON.stringify(OPTIONS) },
          { label: 'Sessions', fieldType: 'MULTI_SELECT', isRequired: false, options: JSON.stringify(['Morning', 'Afternoon']) },
        ],
      });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    const fields = await prisma.rsvpField.findMany({ where: { eventId: ev.eventId, isArchived: false }, orderBy: { order: 'asc' } });
    expect(fields.map((f) => [f.label, f.fieldType])).toEqual([['Dietary needs', 'MULTI_SELECT'], ['Sessions', 'MULTI_SELECT']]);

    // Options are held to the same rule as a DROPDOWN's.
    const badOptions = await request(app)
      .post(`/api/events/${ev.eventId}/rsvp-fields`)
      .set(headersFor(ev.organiser))
      .send({ label: 'Sessions', fieldType: 'MULTI_SELECT', options: 'Morning, Afternoon', order: 2 });
    expect(badOptions.status).toBe(422);
    expect(badOptions.body.code).toBe('RSVP_FIELD_OPTIONS_INVALID');
  }, 90000);
});

describe('changing a question to or from MULTI_SELECT', () => {
  const putField = (ev: PublicEventFixture, fieldId: string, body: Record<string, unknown>) =>
    request(app).put(`/api/events/${ev.eventId}/rsvp-fields/${fieldId}`).set(headersFor(ev.organiser)).send(body);
  const fullUpdate = (ev: PublicEventFixture, field: Record<string, unknown>) =>
    request(app).put(`/api/events/${ev.eventId}/full`).set(headersFor(ev.organiser)).send({ rsvpFields: [field] });

  it('is refused with 409 RSVP_FIELD_TYPE_LOCKED once the question has answers, on both edit paths', async () => {
    const ev = await createPublicEvent({ event: { hostName: 'Durban Chess Club' } });
    const by = ev.organiser.id;
    const diet = await prisma.rsvpField.create({
      data: {
        eventId: ev.eventId, label: 'Dietary needs', fieldType: 'MULTI_SELECT', isRequired: false,
        options: JSON.stringify(OPTIONS), order: 0, createdBy: by, updatedBy: by,
      },
    });
    const size = await prisma.rsvpField.create({
      data: {
        eventId: ev.eventId, label: 'T-shirt size', fieldType: 'DROPDOWN', isRequired: false,
        options: JSON.stringify(['S', 'M']), order: 1, createdBy: by, updatedBy: by,
      },
    });
    const { invite } = await createTestGuestWithInvite(ev.eventId, by, [ev.dayIds[0]!]);
    expect((await rsvpFor(ev, invite.token)({
      rsvpResponses: [{ rsvpFieldId: diet.id, value: ['Vegan'] }, { rsvpFieldId: size.id, value: 'M' }],
    })).status).toBe(200);

    // From MULTI_SELECT, to a single choice or text.
    for (const fieldType of ['DROPDOWN', 'TEXT']) {
      const res = await putField(ev, diet.id, { fieldType });
      expect(res.status, fieldType).toBe(409);
      expect(res.body).toMatchObject({
        code: 'RSVP_FIELD_TYPE_LOCKED',
        message: "'Dietary needs' already has answers, so it can't be changed to or from multi-select. Add a new field instead.",
      });
    }
    const fromViaFull = await fullUpdate(ev, { id: diet.id, label: 'Dietary needs', fieldType: 'DROPDOWN', options: JSON.stringify(OPTIONS) });
    expect(fromViaFull.status).toBe(409);
    expect(fromViaFull.body.code).toBe('RSVP_FIELD_TYPE_LOCKED');
    expect((await prisma.rsvpField.findUniqueOrThrow({ where: { id: diet.id } })).fieldType).toBe('MULTI_SELECT');

    // To MULTI_SELECT, from a single choice.
    const to = await putField(ev, size.id, { fieldType: 'MULTI_SELECT' });
    expect(to.status).toBe(409);
    expect(to.body.code).toBe('RSVP_FIELD_TYPE_LOCKED');
    const toViaFull = await request(app)
      .put(`/api/events/${ev.eventId}/full`)
      .set(headersFor(ev.organiser))
      .send({
        rsvpFields: [
          { id: diet.id, label: 'Dietary needs', fieldType: 'MULTI_SELECT', options: JSON.stringify(OPTIONS) },
          { id: size.id, label: 'T-shirt size', fieldType: 'MULTI_SELECT', options: JSON.stringify(['S', 'M']) },
        ],
      });
    expect(toViaFull.status).toBe(409);
    expect(toViaFull.body.code).toBe('RSVP_FIELD_TYPE_LOCKED');
    expect((await prisma.rsvpField.findUniqueOrThrow({ where: { id: size.id } })).fieldType).toBe('DROPDOWN');

    // Every other edit of an answered question still saves, and so does a
    // change between two unlocked types.
    expect((await putField(ev, diet.id, { label: 'Dietary requirements', fieldType: 'MULTI_SELECT' })).status).toBe(200);
    expect((await putField(ev, size.id, { fieldType: 'TEXT' })).status).toBe(200);
  }, 120000);

  it('is allowed while the question has no answers (none chosen is not an answer)', async () => {
    const ev = await createPublicEvent();
    const { diet } = await addQuestions(ev);
    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    expect((await rsvpFor(ev, invite.token)({ rsvpResponses: [{ rsvpFieldId: diet.id, value: [] }] })).status).toBe(200);

    expect((await putField(ev, diet.id, { fieldType: 'DROPDOWN' })).status).toBe(200);
    expect((await putField(ev, diet.id, { fieldType: 'MULTI_SELECT' })).status).toBe(200);
  }, 90000);
});
