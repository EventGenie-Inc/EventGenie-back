import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';

// ─────────────────────────────────────────
//  SAFETY LIMITS — venue capacity is a whole number from 1 to 100,000
//
//  A tester's 100,000,000,000 passed the old "positive whole number" check
//  and came back from the integer column as a 500. Anything outside the
//  range is now 422 EVENT_CAPACITY_INVALID on create, update and the
//  wizard's materialize, and nothing is written.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let eventId: string;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventId = (await createEventWithDay(tenant.id, organiser.id)).event.id;
}, 60000);

afterAll(async () => {
  await prisma.eventDraft.deleteMany({ where: { createdByUserId: organiser.id } });
  await deleteTenantsDeep(tenantIds.splice(0));
}, 120000);

const INVALID = {
  status: 'error',
  message: 'Venue capacity must be a whole number from 1 to 100,000.',
  code: 'EVENT_CAPACITY_INVALID',
};
const BAD_VALUES: unknown[] = [100_000_000_000, 100_001, 0, -5, 12.5, '500', true];

describe('venue capacity', () => {
  it('create: every value outside 1–100,000 is 422 with the code and creates nothing; 1 and 100,000 are fine', async () => {
    installFirebaseMock();
    const before = await prisma.event.count({ where: { tenantId: organiser.tenantId! } });
    for (const capacity of BAD_VALUES) {
      const res = await request(app).post('/api/events').set(headersFor(organiser)).send({ name: 'Capacity check', capacity });
      expect(res.status, `capacity ${String(capacity)}`).toBe(422);
      expect(res.body).toEqual(INVALID);
    }
    expect(await prisma.event.count({ where: { tenantId: organiser.tenantId! } })).toBe(before);

    for (const capacity of [1, 100_000]) {
      const res = await request(app).post('/api/events').set(headersFor(organiser)).send({ name: 'Capacity check', capacity });
      expect(res.status).toBe(201);
      expect(res.body.data.capacity).toBe(capacity);
    }
  }, 60000);

  it('update: the tester’s 100,000,000,000 is 422, never a 500, and the stored value is untouched; null clears it', async () => {
    installFirebaseMock();
    await prisma.event.update({ where: { id: eventId }, data: { capacity: 250 } });
    const res = await request(app).put(`/api/events/${eventId}`).set(headersFor(organiser)).send({ capacity: 100_000_000_000 });
    expect(res.status).toBe(422);
    expect(res.body).toEqual(INVALID);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).capacity).toBe(250);

    const cleared = await request(app).put(`/api/events/${eventId}`).set(headersFor(organiser)).send({ capacity: null });
    expect(cleared.status).toBe(200);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).capacity).toBeNull();
  }, 60000);

  it('wizard materialize: an out-of-range capacity is 422 with the code and no event is made', async () => {
    const before = await prisma.event.count({ where: { tenantId: organiser.tenantId! } });
    await eventDraftRepository.upsert(organiser.tenantId!, organiser.id, {
      currentStep: 4,
      payload: {
        name: 'Wizard capacity',
        capacity: 100_000_000_000,
        days: [{ label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Road' }],
      },
    });
    await expect(eventDraftService.materialize(organiser.tenantId!, organiser.id)).rejects.toMatchObject({
      statusCode: 422,
      code: 'EVENT_CAPACITY_INVALID',
    });
    expect(await prisma.event.count({ where: { tenantId: organiser.tenantId! } })).toBe(before);
  }, 60000);
});
