import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
//  GET /api/events — feedbackGiven per event
//
//  Each event in the list says whether its organiser feedback has been
//  given, so the list's cards don't each ask GET .../feedback. An archived
//  feedback row is not feedback given. With `feedback` off the field is
//  left out, like the feature's routes.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let withFeedback: string;
let withArchivedFeedback: string;
let without: string;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  withFeedback = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  withArchivedFeedback = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  without = (await createEventWithDay(tenant.id, organiser.id)).event.id;
  const feedback = (eventId: string, isArchived: boolean) =>
    prisma.eventFeedback.create({ data: { eventId, tenantId: tenant.id, score: 9, submittedBy: organiser.id, updatedBy: organiser.id, isArchived } });
  await feedback(withFeedback, false);
  await feedback(withArchivedFeedback, true);
}, 60000);

beforeEach(() => installFirebaseMock());
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await prisma.eventFeedback.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await deleteTenantsDeep(tenantIds.splice(0));
  await prisma.$disconnect();
}, 60000);

const list = async () => {
  const res = await request(app).get('/api/events').set(headersFor(organiser));
  expect(res.status).toBe(200);
  return new Map<string, Record<string, unknown>>(res.body.data.map((e: { id: string }) => [e.id, e]));
};

describe('GET /api/events — feedbackGiven', () => {
  it('is true only for an event with live feedback', async () => {
    const events = await list();
    expect(events.get(withFeedback)?.feedbackGiven).toBe(true);
    expect(events.get(withArchivedFeedback)?.feedbackGiven).toBe(false);
    expect(events.get(without)?.feedbackGiven).toBe(false);
  }, 60000);

  it('is left out while feedback is switched off', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'feedback');
    const events = await list();
    expect(events.get(withFeedback)).not.toHaveProperty('feedbackGiven');
  }, 60000);
});
