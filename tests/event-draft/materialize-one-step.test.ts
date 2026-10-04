import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  deleteTestEvent,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  WIZARD IN ONE STEP — materialize sets each program item's day and the
//  program's visibility itself
//
//  The wizard used to create the event, then make one follow-up call per
//  program item to set its day, and another to hide the program. Each
//  item now names its day by `dayIndex` (its position in the draft's
//  `days`), and `program.isPublished` is honoured, all inside
//  materialize's one transaction. A bad index is 422 and creates nothing.
// ─────────────────────────────────────────

let tenantId: string;
let userId: string;

beforeAll(async () => {
  tenantId = (await createTestTenant()).id;
  userId = (await createTestUserRow({ role: 'TENANT_ADMIN', tenantId })).id;
}, 60000);

afterAll(async () => {
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: userId } });
  const events = await prisma.event.findMany({ where: { tenantId }, select: { id: true } });
  for (const { id } of events) {
    const programs = await prisma.eventProgram.findMany({ where: { eventId: id }, select: { id: true } });
    await prisma.programItem.deleteMany({ where: { programId: { in: programs.map((p) => p.id) } } });
    await prisma.eventProgram.deleteMany({ where: { eventId: id } });
    await prisma.eventDay.deleteMany({ where: { eventId: id } });
    await deleteTestEvent(id);
  }
  await deleteTestUserRow(userId);
  await deleteTestTenant(tenantId);
  await prisma.$disconnect();
}, 60000);

const DAY = (label: string, date: string) => ({ label, date: `${date}T00:00:00`, location: 'Hall', address: '1 Road' });
const TWO_DAYS = [DAY('Saturday', '2030-03-02'), DAY('Sunday', '2030-03-03')];

const materialize = async (payload: Record<string, unknown>) => {
  await eventDraftRepository.upsert(tenantId, userId, { currentStep: 4, payload: { name: 'One step', ...payload } });
  return eventDraftService.materialize(tenantId, userId);
};

const programOf = (eventId: string) =>
  prisma.eventProgram.findFirstOrThrow({ where: { eventId }, include: { programItems: { orderBy: { order: 'asc' } } } });

describe('eventDraftService.materialize — item days and program visibility', () => {
  it("sets each item's eventDayId from its dayIndex, in the same call", async () => {
    const event = await materialize({
      days: TWO_DAYS,
      program: {
        items: [
          { title: 'Ceremony', startTime: '2030-03-02T14:00', dayIndex: 0 },
          { title: 'Brunch', startTime: '2030-03-03T10:00', dayIndex: 1 },
        ],
      },
    });
    const days = await prisma.eventDay.findMany({ where: { eventId: event!.id } });
    const idOf = (label: string) => days.find((d) => d.label === label)!.id;
    const program = await programOf(event!.id);
    expect(program.programItems.map((i) => [i.title, i.eventDayId])).toEqual([
      ['Ceremony', idOf('Saturday')],
      ['Brunch', idOf('Sunday')],
    ]);
    expect(program.isPublished).toBe(true);
  }, 60000);

  it('honours program.isPublished false; a single-day item without a dayIndex stays NULL', async () => {
    const event = await materialize({
      days: [DAY('Only day', '2030-04-01')],
      program: { isPublished: false, items: [{ title: 'Dinner', startTime: '2030-04-01T19:00' }] },
    });
    const program = await programOf(event!.id);
    expect(program.isPublished).toBe(false);
    expect(program.programItems[0]!.eventDayId).toBeNull();
  }, 60000);

  it('an out-of-range or non-whole dayIndex, or none on a multi-day draft, is 422 and creates nothing', async () => {
    const before = await prisma.event.count({ where: { tenantId } });
    const cases: [unknown, RegExp][] = [
      [2, /'Ceremony' is set to a day that isn't part of this event/],
      [-1, /'Ceremony' is set to a day that isn't part of this event/],
      [0.5, /'Ceremony' is set to a day that isn't part of this event/],
      ['0', /'Ceremony' is set to a day that isn't part of this event/],
      [undefined, /Choose the day 'Ceremony' happens on/],
    ];
    for (const [dayIndex, message] of cases) {
      const err = await materialize({
        days: TWO_DAYS,
        program: { items: [{ title: 'Ceremony', startTime: '2030-03-02T14:00', ...(dayIndex !== undefined && { dayIndex }) }] },
      }).catch((e) => e);
      expect(err, String(dayIndex)).toMatchObject({ statusCode: 422 });
      expect(err.message).toMatch(message);
    }
    expect(await prisma.event.count({ where: { tenantId } })).toBe(before);
  }, 90000);
});
