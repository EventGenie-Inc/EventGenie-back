import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  AN ARCHIVED INVITE'S TOKEN OPENS NOTHING
//
//  An organiser can archive one invite and keep its guest. From then its
//  token is exactly an unknown one on every token route: the same status
//  and the same words (registration-approval-gate.util.ts's
//  INVITE_TOKEN_USABLE requires a live invite). Until 2026-11 the
//  invitation still opened. Restoring the invite opens it again: each
//  route's answer to the live token differs from an unknown one, which
//  proves the route tells them apart at all.
// ─────────────────────────────────────────

let tenantId: string;
let organiser: Actor;
let eventId: string;
let dayId: string;
const guestId = randomUUID();
const inviteId = randomUUID();
const token = `archived-${randomUUID()}`;

type Call = (token: string) => request.Test;

// Every guest-facing token route, plus check-in's scan (organiser, by token).
const routes: Record<string, { call: Call; controlDiffers: boolean }> = {
  'GET /api/rsvp/validate/:token': { call: (t) => request(app).get(`/api/rsvp/validate/${encodeURIComponent(t)}`), controlDiffers: true },
  'POST /api/rsvp/qr': { call: (t) => request(app).post('/api/rsvp/qr').send({ token: t }), controlDiffers: true },
  'POST /api/rsvp/program': { call: (t) => request(app).post('/api/rsvp/program').send({ token: t }), controlDiffers: true },
  'POST /api/memory-hub/guest-view': { call: (t) => request(app).post('/api/memory-hub/guest-view').send({ token: t }), controlDiffers: true },
  'POST /api/memory-hub/guest-upload-signature': {
    call: (t) => request(app).post('/api/memory-hub/guest-upload-signature').send({ token: t, mediaType: 'IMAGE' }),
    controlDiffers: true,
  },
  // A live token with no such upload is the same 404, so no control here.
  'POST /api/storage/files/guest-release': {
    call: (t) => request(app).post('/api/storage/files/guest-release').send({ token: t, publicId: 'nothing/here' }),
    controlDiffers: false,
  },
  'POST check-in by inviteToken': {
    call: (t) => request(app).post(`/api/events/${eventId}/check-in/days/${dayId}`).set(headersFor(organiser)).send({ inviteToken: t }),
    controlDiffers: true,
  },
  // Last: a live submit records an answer.
  'POST /api/rsvp/submit': { call: (t) => request(app).post('/api/rsvp/submit').send({ token: t, attending: false }), controlDiffers: true },
};

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  organiser = await createActor('TENANT_ADMIN', tenantId);
  const { event, day } = await createEventWithDay(tenantId, organiser.id, `Archived invite ${randomUUID()}`);
  eventId = event.id;
  dayId = day.id;
  await prisma.guest.create({ data: { id: guestId, eventId, firstName: 'Kept', email: `kept-${randomUUID()}@test.invalid` } });
  await prisma.invite.create({
    data: { id: inviteId, eventId, guestId, token, status: 'PENDING', deliveryMethod: 'EMAIL', deliveredAt: new Date(), createdBy: organiser.id, updatedBy: organiser.id },
  });
  await prisma.inviteEventDay.create({ data: { inviteId, eventDayId: dayId } });
}, 60_000);

afterAll(async () => {
  await deleteTenantsDeep([tenantId]);
}, 60_000);

beforeEach(() => {
  installFirebaseMock();
});

describe("an archived invite's token, its guest still on the list", () => {
  it('gets exactly the unknown-token answer on every token route', async () => {
    const archived = await request(app).delete(`/api/events/${eventId}/invites/${inviteId}`).set(headersFor(organiser));
    expect(archived.status).toBe(200);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).isArchived).toBe(false);

    for (const [name, route] of Object.entries(routes)) {
      const unknown = await route.call(`archived-unknown-${randomUUID()}`);
      const res = await route.call(token);
      expect({ route: name, status: res.status, body: res.body }).toEqual({ route: name, status: unknown.status, body: unknown.body });
      expect([400, 404, 410]).toContain(res.status);
    }
  }, 60_000);

  it('opens again once the invite is restored', async () => {
    const restored = await request(app).post(`/api/events/${eventId}/invites/${inviteId}/reactivate`).set(headersFor(organiser));
    expect(restored.status).toBe(200);

    for (const [name, route] of Object.entries(routes)) {
      if (!route.controlDiffers) continue;
      const unknown = await route.call(`archived-unknown-${randomUUID()}`);
      const live = await route.call(token);
      expect({ route: name, differs: live.status !== unknown.status || JSON.stringify(live.body) !== JSON.stringify(unknown.body) })
        .toEqual({ route: name, differs: true });
    }
    expect((await routes['GET /api/rsvp/validate/:token']!.call(token)).status).toBe(200);
  }, 60_000);
});
