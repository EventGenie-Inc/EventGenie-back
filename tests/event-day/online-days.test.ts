import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import request from 'supertest';

// ─────────────────────────────────────────
//  ONLINE EVENT DAYS
//
//  A day can happen online instead of at a venue: no address, no map, an
//  optional https link. Guests and the public page read "Online"; the link
//  only reaches people invited or registered (their invitation, the
//  Program tab, the invitation, reminder and registration emails), never
//  the public page. Days saved before it existed are still venues.
// ─────────────────────────────────────────

import app from '../../src/app.js';
import { createActor, createTenant, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { clearSentEmails, sentEmails } from '../helpers/sent-emails.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { buildInviteEmail, buildReminderEmail } from '../../src/modules/invite/invite-message.util.js';
import { STAND_IN_QR } from '../helpers/qr.js';

vi.setConfig({ testTimeout: 120_000 });

const BASE = 'https://app.example.test';
const LINK = 'https://lichess.org/tournament/club-open-42';

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
}, 60_000);

beforeEach(() => {
  installFirebaseMock();
  vi.stubEnv('FRONTEND_BASE_URL', BASE);
  clearSentEmails();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await deleteTenantsDeep(tenantIds.splice(0));
}, 120_000);

const addOnlineDay = (eventId: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/events/${eventId}/days`)
    .set(headersFor(organiser))
    .send({ label: 'Round 1', date: '2027-06-01', locationType: 'ONLINE', onlineUrl: LINK, ...body });

const inviteGuest = async (eventId: string, dayIds: string[]) => {
  const { invite } = await guestRepository.createWithInvite(eventId, organiser.id, {
    firstName: 'Sipho',
    surname: null,
    email: `online-${randomBytes(6).toString('hex')}@test.invalid`,
    phoneNumber: null,
    eventDayIds: dayIds,
    plusOnesAllowed: 0,
  });
  return invite.token;
};

describe('saving an online day', () => {
  it('saves without an address: no venue, no coordinates, the link kept', async () => {
    const { event } = await createEventWithDay(tenantId, organiser.id);

    const res = await addOnlineDay(event.id, { location: 'ignored', address: 'ignored', latitude: -33.9, longitude: 18.4 });

    expect(res.status).toBe(201);
    const day = await prisma.eventDay.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(day).toMatchObject({ locationType: 'ONLINE', onlineUrl: LINK, location: null, address: null, latitude: null, longitude: null });
    // The link is optional.
    const noLink = await addOnlineDay(event.id, { label: 'Round 2', onlineUrl: undefined });
    expect(noLink.status).toBe(201);
    expect(noLink.body.data).toMatchObject({ locationType: 'ONLINE', onlineUrl: null });
  });

  it('refuses a link that is not https, with its code, saving nothing', async () => {
    const { event } = await createEventWithDay(tenantId, organiser.id);
    for (const onlineUrl of ['http://lichess.org/tournament/x', 'javascript:alert(1)', 'lichess.org/tournament/x', 'https://user:pass@lichess.org/x', 'https://localhost/x', 'https://lichess .org', 42]) {
      const res = await addOnlineDay(event.id, { label: `Round ${randomBytes(3).toString('hex')}`, onlineUrl });
      expect(res.status, String(onlineUrl)).toBe(422);
      expect(res.body.code, String(onlineUrl)).toBe('EVENT_DAY_ONLINE_URL_INVALID');
    }
    expect(await prisma.eventDay.count({ where: { eventId: event.id, locationType: 'ONLINE' } })).toBe(0);

    const badType = await addOnlineDay(event.id, { locationType: 'ZOOM' });
    expect(badType.status).toBe(422);
    expect(badType.body.code).toBe('EVENT_DAY_LOCATION_TYPE_INVALID');
  });

  it('a day switched back to a venue needs a venue again, and loses its link', async () => {
    const { event } = await createEventWithDay(tenantId, organiser.id);
    const { body } = await addOnlineDay(event.id);
    const url = `/api/events/${event.id}/days/${body.data.id}`;

    const noVenue = await request(app).put(url).set(headersFor(organiser)).send({ locationType: 'VENUE' });
    expect(noVenue.status).toBe(422);

    const venue = await request(app).put(url).set(headersFor(organiser)).send({ locationType: 'VENUE', location: 'Club hall', address: '1 Main Road, Durban' });
    expect(venue.status).toBe(200);
    expect(venue.body.data).toMatchObject({ locationType: 'VENUE', location: 'Club hall', onlineUrl: null });
  });

  it('the full update turns a saved day online, and publishing accepts an online day', async () => {
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    await prisma.event.update({ where: { id: event.id }, data: { status: 'DRAFT', hostName: 'Durban Chess Club' } });

    const res = await request(app)
      .put(`/api/events/${event.id}/full`)
      .set(headersFor(organiser))
      .send({ days: [{ id: day.id, label: day.label, date: '2027-03-01', locationType: 'ONLINE', onlineUrl: LINK }] });
    expect(res.status).toBe(200);
    expect(await prisma.eventDay.findUniqueOrThrow({ where: { id: day.id } })).toMatchObject({ locationType: 'ONLINE', onlineUrl: LINK, address: null });

    const publish = await request(app).post(`/api/events/${event.id}/publish`).set(headersFor(organiser));
    expect(publish.status).toBe(200);
  });
});

describe('who sees the link', () => {
  it('an invited guest sees "Online" and the link, on their invitation and the Program tab', async () => {
    const { event } = await createEventWithDay(tenantId, organiser.id);
    const online = await addOnlineDay(event.id);
    const token = await inviteGuest(event.id, [online.body.data.id]);

    const view = await request(app).get(`/api/rsvp/validate/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.invite.inviteEventDay[0].eventDay).toMatchObject({
      locationType: 'ONLINE',
      location: 'Online',
      address: null,
      latitude: null,
      longitude: null,
      onlineUrl: LINK,
    });
    // The compatibility keys read "Online" too, never an empty venue.
    expect(view.body.data.invite.event).toMatchObject({ location: 'Online', address: null });

    const programme = await prisma.eventProgram.create({
      data: { eventId: event.id, title: 'Programme', isPublished: true, createdBy: organiser.id, updatedBy: organiser.id },
    });
    await prisma.programItem.create({
      data: {
        programId: programme.id,
        eventDayId: online.body.data.id,
        title: 'Round 1 pairings',
        startTime: new Date('2027-06-01T09:00:00Z'),
        order: 0,
        createdBy: organiser.id,
        updatedBy: organiser.id,
      },
    });
    const program = await request(app).post('/api/rsvp/program').send({ token });
    expect(program.body.data.available).toBe(true);
    expect(program.body.data.days[0]).toMatchObject({ locationType: 'ONLINE', location: 'Online', address: null, onlineUrl: LINK });
  });

  it('the public page shows "Online" and never the link; registering emails it', async () => {
    const { event } = await createEventWithDay(tenantId, organiser.id);
    const shareToken = randomBytes(32).toString('hex');
    await prisma.event.update({ where: { id: event.id }, data: { visibility: 'PUBLIC', shareToken, hostName: 'Durban Chess Club' } });
    await prisma.eventDay.updateMany({ where: { eventId: event.id }, data: { isArchived: true } });
    const online = await addOnlineDay(event.id);
    expect(online.status).toBe(201);

    const view = await request(app).get(`/api/public-events/${shareToken}`);
    expect(view.status).toBe(200);
    expect(view.body.data.days).toEqual([
      expect.objectContaining({ id: online.body.data.id, locationType: 'ONLINE', location: 'Online', address: null }),
    ]);
    expect(Object.keys(view.body.data.days[0])).not.toContain('onlineUrl');
    expect(JSON.stringify(view.body)).not.toContain('lichess');

    const email = `reg-${randomBytes(6).toString('hex')}@test.invalid`;
    const registered = await request(app).post(`/api/public-events/${shareToken}/register`).send({ firstName: 'Ayanda', email });
    expect(registered.status).toBe(201);
    expect(JSON.stringify(registered.body)).not.toContain('lichess');
    const sent = sentEmails().find((e) => e.to === email);
    expect(sent?.text).toContain('Online');
    expect(sent?.text).toContain(LINK);
  });

  it('invitation and reminder emails say "Online" and give the link, never an address', () => {
    const input = {
      eventName: 'Club Open',
      hostName: 'Durban Chess Club',
      days: [{ label: 'Round 1', date: new Date('2027-06-01'), location: null, address: null, locationType: 'ONLINE' as const, onlineUrl: LINK }],
      fallbackDateLabel: null,
      rsvpDeadline: null,
      rsvpLink: `${BASE}/rsvp?token=x`,
      rsvpQr: STAND_IN_QR,
      design: null,
      organiserEmail: null,
    };
    for (const built of [buildInviteEmail(input), buildReminderEmail(input)]) {
      expect(built.text).toContain('Online');
      expect(built.text).toContain(LINK);
      expect(built.html).toContain(LINK);
    }
  });
});

describe('existing physical events', () => {
  it('stay venues: a day saved before Online existed reads and edits exactly as before', async () => {
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    // As the migration leaves an old row if the default were ever missing.
    await prisma.$executeRaw`UPDATE "EventDay" SET "locationType" = NULL WHERE "id" = ${day.id}`;
    const token = await inviteGuest(event.id, [day.id]);

    const view = await request(app).get(`/api/rsvp/validate/${token}`);
    expect(view.body.data.invite.inviteEventDay[0].eventDay).toMatchObject({
      locationType: 'VENUE',
      location: 'Test Venue',
      address: '1 Test Road, Cape Town',
      onlineUrl: null,
    });

    const renamed = await request(app)
      .put(`/api/events/${event.id}/days/${day.id}`)
      .set(headersFor(organiser))
      .send({ label: 'Opening day' });
    expect(renamed.status).toBe(200);
    expect(await prisma.eventDay.findUniqueOrThrow({ where: { id: day.id } })).toMatchObject({
      label: 'Opening day',
      locationType: 'VENUE',
      location: 'Test Venue',
      address: '1 Test Road, Cape Town',
      onlineUrl: null,
    });

    // A new day without a type is a venue, held to the venue rules.
    const noVenue = await request(app)
      .post(`/api/events/${event.id}/days`)
      .set(headersFor(organiser))
      .send({ label: 'Day 2', date: '2027-06-02' });
    expect(noVenue.status).toBe(422);
  });
});
