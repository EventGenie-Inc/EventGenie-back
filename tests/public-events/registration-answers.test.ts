import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import app from '../../src/app.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, view, freshEmail, prisma, type PublicEventFixture } from './helpers.js';

// ─────────────────────────────────────────
//  THE EVENT'S QUESTIONS AT PUBLIC REGISTRATION
//
//  The registration page gets the event's additional fields exactly as the
//  RSVP form does (id, label, type, options, required), and registering
//  takes answers as RSVP submit does (rsvpResponses: [{ rsvpFieldId, value }]),
//  checked and stored by the same helper (rsvp-answers.util.ts) with the
//  same messages and codes. Stored on the registrant's invite, so the guest
//  details and the export show them like any RSVP's.
// ─────────────────────────────────────────

beforeEach(() => installFirebaseMock());

afterEach(async () => {
  await cleanupPublicEventFixtures();
});

const addQuestions = async (ev: PublicEventFixture) => {
  const by = ev.organiser.id;
  const dietary = await prisma.rsvpField.create({
    data: { eventId: ev.eventId, label: 'Dietary needs', fieldType: 'TEXT', isRequired: true, order: 0, createdBy: by, updatedBy: by },
  });
  const shirt = await prisma.rsvpField.create({
    data: {
      eventId: ev.eventId, label: 'T-shirt size', fieldType: 'DROPDOWN', isRequired: false, options: JSON.stringify(['S', 'M', 'L']),
      order: 1, createdBy: by, updatedBy: by,
    },
  });
  const seats = await prisma.rsvpField.create({
    data: { eventId: ev.eventId, label: 'Seats', fieldType: 'NUMBER', isRequired: false, order: 2, createdBy: by, updatedBy: by },
  });
  // Archived: never shown, never answerable.
  await prisma.rsvpField.create({
    data: { eventId: ev.eventId, label: 'Old question', fieldType: 'TEXT', isRequired: true, isArchived: true, order: 3, createdBy: by, updatedBy: by },
  });
  return { dietary, shirt, seats };
};

const registrantsOf = (eventId: string) =>
  prisma.guest.findMany({ where: { eventId, selfRegisteredAt: { not: null } }, include: { invites: { include: { rsvpResponses: true } } } });

describe('the public view', () => {
  it('lists the live questions in order, as the RSVP form receives them', async () => {
    const ev = await createPublicEvent();
    const { dietary, shirt, seats } = await addQuestions(ev);
    const res = await view(ev.shareToken);
    expect(res.status).toBe(200);
    expect(res.body.data.rsvpFields).toEqual([
      { id: dietary.id, label: 'Dietary needs', fieldType: 'TEXT', isRequired: true, options: null },
      { id: shirt.id, label: 'T-shirt size', fieldType: 'DROPDOWN', isRequired: false, options: '["S","M","L"]' },
      { id: seats.id, label: 'Seats', fieldType: 'NUMBER', isRequired: false, options: null },
    ]);
  }, 60000);
});

describe('registering with answers', () => {
  it('saves them on the registrant’s invite; the guest details and the export show them', async () => {
    const ev = await createPublicEvent();
    const { dietary, shirt } = await addQuestions(ev);
    const res = await register(ev.shareToken, {
      rsvpResponses: [{ rsvpFieldId: dietary.id, value: 'Vegetarian' }, { rsvpFieldId: shirt.id, value: 'M' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [registrant] = await registrantsOf(ev.eventId);
    const invite = registrant!.invites[0]!;
    expect(invite.rsvpResponses.map((r) => [r.rsvpFieldId, r.value]).sort()).toEqual(
      [[dietary.id, 'Vegetarian'], [shirt.id, 'M']].sort()
    );

    // Guest details (the organiser's guest modal reads this).
    const details = await request(app).get(`/api/invites/${invite.id}/rsvp-responses`).set(headersFor(ev.organiser));
    expect(details.status).toBe(200);
    expect(details.body.data.map((r: { value: string }) => r.value).sort()).toEqual(['M', 'Vegetarian']);

    // The export.
    const { buffer } = await guestService.exportGuests(ev.eventId, 'TENANT_ADMIN', ev.tenantId);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const values: string[] = [];
    workbook.getWorksheet('Guests')!.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value))));
    expect(values).toEqual(expect.arrayContaining(['Dietary needs', 'Vegetarian', 'T-shirt size', 'M']));
  }, 90000);

  it('a missing required answer is a coded 422, the same as at RSVP, and creates no one', async () => {
    const ev = await createPublicEvent();
    const { dietary, shirt } = await addQuestions(ev);
    const expected = {
      message: "Please answer 'Dietary needs'. The organiser needs this to plan for you.",
      code: 'RSVP_ANSWER_REQUIRED',
    };

    const none = await register(ev.shareToken, {});
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject(expected);
    const blank = await register(ev.shareToken, {
      rsvpResponses: [{ rsvpFieldId: dietary.id, value: '   ' }, { rsvpFieldId: shirt.id, value: 'S' }],
    });
    expect(blank.status).toBe(422);
    expect(blank.body).toMatchObject(expected);
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);

    // RSVP submit refuses the same way, with the same code.
    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    const rsvp = await request(app).post('/api/rsvp/submit').send({ token: invite.token, attending: true, firstName: 'Lebo', attendingDayIds: [ev.dayIds[0]] });
    expect(rsvp.status).toBe(422);
    expect(rsvp.body).toMatchObject(expected);
  }, 90000);

  it('an unknown field id (another event’s, an archived one, or made up) is a coded 400, and creates no one', async () => {
    const ev = await createPublicEvent();
    const { dietary } = await addQuestions(ev);
    const other = await createPublicEvent();
    const { dietary: foreign } = await addQuestions(other);
    const archived = await prisma.rsvpField.findFirstOrThrow({ where: { eventId: ev.eventId, isArchived: true } });

    for (const rsvpFieldId of [foreign.id, archived.id, 'not-a-field']) {
      const res = await register(ev.shareToken, {
        rsvpResponses: [{ rsvpFieldId: dietary.id, value: 'None' }, { rsvpFieldId, value: 'x' }],
      });
      expect(res.status, rsvpFieldId).toBe(400);
      expect(res.body).toMatchObject({
        code: 'RSVP_ANSWER_UNKNOWN_FIELD',
        message: "One of your answers isn't for this event's questions. Please refresh the page and try again.",
      });
    }
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);
  }, 90000);

  it('an answer that isn’t its question’s type is RSVP’s coded 422; a malformed list is the generic 400', async () => {
    const ev = await createPublicEvent();
    const { dietary, seats } = await addQuestions(ev);
    const wrongType = await register(ev.shareToken, {
      rsvpResponses: [{ rsvpFieldId: dietary.id, value: 'None' }, { rsvpFieldId: seats.id, value: 'two' }],
    });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body).toMatchObject({ message: "Enter a number for 'Seats'.", code: 'RSVP_ANSWER_INVALID' });

    const malformed = await register(ev.shareToken, { rsvpResponses: [{ rsvpFieldId: dietary.id, value: 3 }] });
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).toBe('Something went wrong with your registration. Please refresh the page and try again.');
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);
  }, 90000);

  it('a DROPDOWN answer must be one of its options, at registration and at RSVP alike', async () => {
    const ev = await createPublicEvent();
    const { dietary, shirt } = await addQuestions(ev);
    const expected = { message: "Choose one of the options for 'T-shirt size'.", code: 'RSVP_ANSWER_INVALID' };
    const answers = (size: string) => [{ rsvpFieldId: dietary.id, value: 'None' }, { rsvpFieldId: shirt.id, value: size }];

    const reg = await register(ev.shareToken, { rsvpResponses: answers('XXL') });
    expect(reg.status).toBe(422);
    expect(reg.body).toMatchObject(expected);
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);

    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    const rsvp = (size: string) =>
      request(app).post('/api/rsvp/submit').send({ token: invite.token, attending: true, firstName: 'Lebo', attendingDayIds: [ev.dayIds[0]], rsvpResponses: answers(size) });
    const refused = await rsvp('XXL');
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject(expected);

    // One of the options is accepted at both; blank is no answer (not required).
    expect((await register(ev.shareToken, { rsvpResponses: answers('L') })).status).toBe(201);
    expect((await register(ev.shareToken, { rsvpResponses: answers('') })).status).toBe(201);
    expect((await rsvp('S')).status).toBe(200);
  }, 90000);

  it('the same question twice in one submission is a coded 422, never a 500, at registration and at RSVP', async () => {
    const ev = await createPublicEvent();
    const { dietary } = await addQuestions(ev);
    const twice = [{ rsvpFieldId: dietary.id, value: 'Vegan' }, { rsvpFieldId: dietary.id, value: 'Halaal' }];
    const expected = {
      message: 'One of the questions was answered more than once. Please refresh the page and try again.',
      code: 'RSVP_ANSWER_DUPLICATE',
    };

    const reg = await register(ev.shareToken, { rsvpResponses: twice });
    expect(reg.status).toBe(422);
    expect(reg.body).toMatchObject(expected);
    expect(await registrantsOf(ev.eventId)).toHaveLength(0);

    const { invite } = await createTestGuestWithInvite(ev.eventId, ev.organiser.id, [ev.dayIds[0]!]);
    const rsvp = await request(app)
      .post('/api/rsvp/submit')
      .send({ token: invite.token, attending: true, firstName: 'Lebo', attendingDayIds: [ev.dayIds[0]], rsvpResponses: twice });
    expect(rsvp.status).toBe(422);
    expect(rsvp.body).toMatchObject(expected);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe('PENDING');
  }, 90000);

  it('the same email again stores no second set of answers', async () => {
    const ev = await createPublicEvent();
    const { dietary } = await addQuestions(ev);
    const email = freshEmail();
    expect((await register(ev.shareToken, { email, rsvpResponses: [{ rsvpFieldId: dietary.id, value: 'Vegan' }] })).status).toBe(201);
    expect((await register(ev.shareToken, { email, rsvpResponses: [{ rsvpFieldId: dietary.id, value: 'Halaal' }] })).status).toBe(201);
    const [registrant] = await registrantsOf(ev.eventId);
    expect(registrant!.invites[0]!.rsvpResponses.map((r) => r.value)).toEqual(['Vegan']);
  }, 90000);
});
