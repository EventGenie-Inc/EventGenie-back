import { describe, it, expect, afterEach } from 'vitest';
import { createPublicEvent, cleanupPublicEventFixtures, view, register, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  THE PUBLIC VIEW — GET /api/public-events/:shareToken
//
//  Returns only what the registration page shows, as an explicit
//  allowlist: the exact keys are pinned here, so a field added to Event,
//  EventDay or the projection later fails this test instead of quietly
//  reaching anyone who holds the link.
// ─────────────────────────────────────────

afterEach(cleanupPublicEventFixtures);

describe('GET /api/public-events/:shareToken', () => {
  it('has exactly the page’s keys, at every level', async () => {
    const ev = await createPublicEvent({
      days: 2,
      event: {
        description: 'Drinks and dinner',
        coverImageUrl: 'https://res.cloudinary.com/democloud/image/upload/v1/cover.jpg',
        registrationEmailDomains: ['company.co.za'],
        registrationPlusOnesAllowed: 1,
        registrationCap: 50,
        capacity: 120,
      },
    });
    const res = await view(ev.shareToken);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['status', 'data']);

    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(['coverImageUrl', 'days', 'description', 'hostName', 'name', 'registration']);
    expect(Object.keys(data.registration).sort()).toEqual(
      ['allowedEmailDomains', 'closesAt', 'isOpen', 'message', 'plusOnesAllowed', 'reason'].sort()
    );
    for (const day of data.days) {
      expect(Object.keys(day).sort()).toEqual(
        ['address', 'date', 'endTime', 'id', 'label', 'location', 'openForRegistration', 'startTime'].sort()
      );
    }
    expect(data).toMatchObject({
      hostName: 'Acme HR',
      description: 'Drinks and dinner',
      registration: { isOpen: true, reason: null, message: null, closesAt: null, plusOnesAllowed: 1, allowedEmailDomains: ['company.co.za'] },
    });
    expect(data.days.map((d: { label: string }) => d.label)).toEqual(['Day 1', 'Day 2']);
    expect(data.days[0]).toMatchObject({ location: 'Test Venue', address: '1 Test Road, Cape Town', openForRegistration: true });
  }, 60000);

  it('never carries an internal value: ids, tenant, share token, cap, capacity, counts, organiser', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 50, capacity: 120 } });
    expect((await register(ev.shareToken, {})).status).toBe(201);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: ev.eventId } });

    const body = JSON.stringify((await view(ev.shareToken)).body);
    for (const internal of [ev.eventId, ev.tenantId, ev.shareToken, ev.organiser.id, ev.organiser.email, event.createdBy]) {
      expect(body).not.toContain(internal);
    }
    expect(body).not.toMatch(/"(status|visibility|tenantId|eventId|shareToken|capacity|registrationCap|cap|createdBy|updatedBy|isArchived|latitude|longitude|registeredCount|count)"\s*:(?!\s*"ok")/);
  }, 60000);

  it('archived days are not shown; a revoked link is a 404', async () => {
    const ev = await createPublicEvent({ days: 2 });
    await prisma.eventDay.update({ where: { id: ev.dayIds[1]! }, data: { isArchived: true } });
    expect((await view(ev.shareToken)).body.data.days).toHaveLength(1);

    await prisma.event.update({ where: { id: ev.eventId }, data: { shareToken: `${ev.shareToken}-new` } });
    const old = await view(ev.shareToken);
    expect(old.status).toBe(404);
    expect(old.body.message).toBe("This registration link isn't valid. Check the link, or ask the organiser for a new one.");
  }, 60000);
});
