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
//  THE TWO DATE RULES THE WIZARD ENFORCES, ON THE SERVER
//
//  1. A new or changed day date earlier than UTC today minus one day is
//     422 EVENT_DAY_DATE_IN_PAST (the slack is for organisers behind UTC);
//     a saved day re-sent with its date unchanged is never refused.
//  2. A program item with a day starts on that day's UTC date, else 422
//     PROGRAM_ITEM_DATE_NOT_ON_DAY — on create, on an update that changes
//     its start or day (judged on what the update leaves), and at the
//     wizard's materialize. (The full event update: full-update.test.ts.)
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let owner: Actor;
let eventId: string;
let dayId: string; // Day 1, 2027-03-01
let programId: string;

// 'YYYY-MM-DD', `offset` days from UTC today.
const utcDay = (offset: number): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
};

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  owner = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, owner.id);
  eventId = event.id;
  dayId = day.id;
  programId = (await prisma.eventProgram.create({ data: { eventId, createdBy: owner.id, updatedBy: owner.id } })).id;
}, 60000);

beforeEach(() => installFirebaseMock());

afterAll(async () => {
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: owner.id } });
  await deleteTenantsDeep(tenantIds.splice(0));
  await prisma.$disconnect();
}, 60000);

const daysUrl = () => `/api/events/${eventId}/days`;
const itemsUrl = () => `/api/events/${eventId}/program/${programId}/items`;
const venue = { location: 'Hall', address: '1 Main Rd' };

describe('a day date in the past', () => {
  it('a new day before UTC yesterday is 422 EVENT_DAY_DATE_IN_PAST, and nothing is saved', async () => {
    const res = await request(app).post(daysUrl()).set(headersFor(owner)).send({ label: 'Too late', date: utcDay(-2), ...venue });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EVENT_DAY_DATE_IN_PAST');
    expect(res.body.message).toBe("The date of 'Too late' has already passed. Choose today or a later date.");
    expect(await prisma.eventDay.count({ where: { eventId, label: 'Too late' } })).toBe(0);
  }, 60000);

  it('UTC yesterday (an organiser behind UTC) and today are accepted', async () => {
    for (const [label, date] of [['Yesterday UTC', utcDay(-1)], ['Today UTC', utcDay(0)]] as const) {
      const res = await request(app).post(daysUrl()).set(headersFor(owner)).send({ label, date, ...venue });
      expect(res.status, label).toBe(201);
    }
  }, 60000);

  it('a saved day whose date has passed stays editable while its date is unchanged; changing it to a past date is refused', async () => {
    const old = await prisma.eventDay.create({
      data: { eventId, label: 'Last year', date: new Date('2025-06-01'), ...venue, createdBy: owner.id, updatedBy: owner.id },
    });
    const same = await request(app).put(`${daysUrl()}/${old.id}`).set(headersFor(owner)).send({ label: 'Last year (renamed)', date: '2025-06-01' });
    expect(same.status).toBe(200);

    const moved = await request(app).put(`${daysUrl()}/${old.id}`).set(headersFor(owner)).send({ date: '2025-06-02' });
    expect(moved.status).toBe(422);
    expect(moved.body.code).toBe('EVENT_DAY_DATE_IN_PAST');
    expect((await prisma.eventDay.findUniqueOrThrow({ where: { id: old.id } })).date.toISOString()).toBe('2025-06-01T00:00:00.000Z');
  }, 60000);

  it('the wizard refuses a draft day in the past', async () => {
    await eventDraftRepository.upsert(owner.tenantId!, owner.id, {
      currentStep: 3,
      payload: { name: 'Past draft', days: [{ label: 'Day 1', date: `${utcDay(-3)}T00:00:00`, ...venue }] },
    });
    await expect(eventDraftService.materialize(owner.tenantId!, owner.id)).rejects.toMatchObject({ statusCode: 422, code: 'EVENT_DAY_DATE_IN_PAST' });
  }, 60000);
});

describe("a program item starts on its day's date", () => {
  it('create: an item filed under Day 1 but starting the next day is 422 PROGRAM_ITEM_DATE_NOT_ON_DAY', async () => {
    const res = await request(app).post(itemsUrl()).set(headersFor(owner)).send({ title: 'Speeches', startTime: '2027-03-02T10:00:00', eventDayId: dayId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROGRAM_ITEM_DATE_NOT_ON_DAY');
    expect(res.body.message).toBe("'Speeches' is set to 'Day 1', so it must start on 1 March 2027. Change its start date or choose another day.");

    const ok = await request(app).post(itemsUrl()).set(headersFor(owner)).send({ title: 'Speeches', startTime: '2027-03-01T23:30:00', eventDayId: dayId });
    expect(ok.status).toBe(201);
  }, 60000);

  it('update: judged on the start and day it leaves, only when one of them changes', async () => {
    const other = await prisma.eventDay.create({
      data: { eventId, label: 'Day 2', date: new Date('2027-03-02'), ...venue, createdBy: owner.id, updatedBy: owner.id },
    });
    const item = await prisma.programItem.create({
      data: { programId, eventDayId: dayId, title: 'Toast', startTime: new Date('2027-03-01T18:00:00Z'), order: 50, createdBy: owner.id, updatedBy: owner.id },
    });
    const h = headersFor(owner);

    // A new day, the start left as it was: still on Day 1's date.
    const moveDay = await request(app).put(`${itemsUrl()}/${item.id}`).set(h).send({ eventDayId: other.id });
    expect(moveDay.status).toBe(422);
    expect(moveDay.body.code).toBe('PROGRAM_ITEM_DATE_NOT_ON_DAY');
    // A new start off its (kept) day.
    const moveStart = await request(app).put(`${itemsUrl()}/${item.id}`).set(h).send({ startTime: '2027-03-02T18:00:00' });
    expect(moveStart.status).toBe(422);
    // Both together: fine.
    const both = await request(app).put(`${itemsUrl()}/${item.id}`).set(h).send({ eventDayId: other.id, startTime: '2027-03-02T18:00:00' });
    expect(both.status).toBe(200);

    // An older item already off its day can still be renamed.
    const legacy = await prisma.programItem.create({
      data: { programId, eventDayId: dayId, title: 'Legacy', startTime: new Date('2027-03-05T09:00:00Z'), order: 51, createdBy: owner.id, updatedBy: owner.id },
    });
    const rename = await request(app).put(`${itemsUrl()}/${legacy.id}`).set(h).send({ title: 'Legacy, renamed', startTime: '2027-03-05T09:00:00Z' });
    expect(rename.status).toBe(200);
  }, 60000);

  it('the wizard refuses a draft item that starts off its day', async () => {
    await eventDraftRepository.upsert(owner.tenantId!, owner.id, {
      currentStep: 3,
      payload: {
        name: 'Item draft',
        days: [{ label: 'Saturday', date: '2030-03-02T00:00:00', ...venue }, { label: 'Sunday', date: '2030-03-03T00:00:00', ...venue }],
        program: { items: [{ title: 'Brunch', startTime: '2030-03-02T10:00', dayIndex: 1 }] },
      },
    });
    await expect(eventDraftService.materialize(owner.tenantId!, owner.id)).rejects.toMatchObject({ statusCode: 422, code: 'PROGRAM_ITEM_DATE_NOT_ON_DAY' });
  }, 60000);
});
