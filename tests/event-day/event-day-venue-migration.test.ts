import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { createTestTenant, deleteTestTenant, createTestUserRow, deleteTestUserRow, prisma } from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  20261001090000_event_day_venue — the DATA half of the migration
//
//  The test database already has the new columns (the migration ran
//  there), so this re-runs the migration's own data block — read from the
//  migration file itself, never a copy — against old-style fixtures: an
//  event with a venue (one live day, one archived), an event whose venue
//  is blank, and a day that already has its own venue. It asserts what the
//  human applying it to the shared database is relying on: every day of an
//  event with a venue gets a trimmed copy, blanks stay NULL, and a venue
//  already on a day is never overwritten. Fixtures are raw inserts because
//  the app can no longer create a venue-less day or an event-level venue.
// ─────────────────────────────────────────

const MIGRATION = 'prisma/migrations/20261001090000_event_day_venue/migration.sql';
const dataBlock = (): string => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('DO $$');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start);
};

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const fn of cleanup) await fn();
  await prisma.$disconnect();
}, 60000);

describe('event day venue migration — data copy', () => {
  it("copies each event's venue onto every one of its days, and nothing else", async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const tag = randomUUID();

    const makeEvent = (location: string | null, address: string | null, lat: number | null, lng: number | null) =>
      prisma.event.create({
        data: {
          tenantId: tenant.id, createdByUserId: user.id, name: `Migration ${tag}`,
          location, address, latitude: lat, longitude: lng,
          createdBy: user.id, updatedBy: user.id,
        },
      });
    const makeDay = (eventId: string, label: string, extra: Record<string, unknown> = {}) =>
      prisma.eventDay.create({
        data: { eventId, label, date: new Date('2027-05-01'), createdBy: user.id, updatedBy: user.id, ...extra },
      });

    const withVenue = await makeEvent('  Lourensford Estate ', '1 Main Rd, Somerset West', -34.07, 18.89);
    const blank = await makeEvent('   ', null, null, null);
    const live = await makeDay(withVenue.id, 'Day 1');
    const archived = await makeDay(withVenue.id, 'Day 2', { isArchived: true });
    const alreadySet = await makeDay(withVenue.id, 'Day 3', { location: 'Own Hall', address: '5 Own St' });
    const noVenue = await makeDay(blank.id, 'Day 1');

    cleanup.push(async () => {
      await prisma.eventDay.deleteMany({ where: { eventId: { in: [withVenue.id, blank.id] } } });
      await prisma.event.deleteMany({ where: { id: { in: [withVenue.id, blank.id] } } });
      await deleteTestUserRow(user.id);
      await deleteTestTenant(tenant.id);
    });

    await prisma.$executeRawUnsafe(dataBlock());

    const read = (id: string) => prisma.eventDay.findUniqueOrThrow({ where: { id } });
    for (const day of [await read(live.id), await read(archived.id)]) {
      expect(day.location).toBe('Lourensford Estate');
      expect(day.address).toBe('1 Main Rd, Somerset West');
      expect(Number(day.latitude)).toBe(-34.07);
      expect(Number(day.longitude)).toBe(18.89);
    }
    expect(await read(alreadySet.id)).toMatchObject({ location: 'Own Hall', address: '5 Own St', latitude: null });
    expect(await read(noVenue.id)).toMatchObject({ location: null, address: null, latitude: null, longitude: null });

    // Safe to run twice: a second pass changes nothing.
    await prisma.$executeRawUnsafe(dataBlock());
    expect((await read(live.id)).location).toBe('Lourensford Estate');
    expect((await read(alreadySet.id)).location).toBe('Own Hall');
  }, 60000);
});
