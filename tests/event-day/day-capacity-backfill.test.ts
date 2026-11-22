import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { createCapacityEvent, cleanupDayCapacityFixtures, prisma } from './day-capacity-fixtures.js';

// ─────────────────────────────────────────
//  THE 20261125090000_event_day_capacity BACKFILL
//
//  Every event with a capacity has it copied to each of its VENUE days;
//  ONLINE days stay null; an event without a capacity leaves its days
//  unlimited. Run here as the migration's own statement, scoped to this
//  test's events (STEERING §6: never a migration's SQL over whole tables).
// ─────────────────────────────────────────

const MIGRATION = 'prisma/migrations/20261125090000_event_day_capacity/migration.sql';

afterAll(cleanupDayCapacityFixtures, 120_000);

// The migration's one UPDATE, with "AND the event is one of these" added to
// its WHERE. Exactly one UPDATE, and the WHERE is its last clause.
const scopedBackfill = (eventIds: string[]): string => {
  const sql = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  const updates = statements.filter((s) => s.startsWith('UPDATE'));
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatch(/WHERE[\s\S]*$/);
  return `${updates[0]} AND d."eventId" IN (${eventIds.map((id) => `'${id}'`).join(', ')})`;
};

describe('day capacity backfill', () => {
  it('copies the event capacity to every venue day, leaves online days null, and leaves events without one unlimited', async () => {
    // A three-day event with capacity 10: two venue days and one online.
    const threeDay = await createCapacityEvent(
      [{ label: 'Friday' }, { label: 'Saturday' }, { label: 'Sunday', online: true }],
      { capacity: 10 }
    );
    const noCapacity = await createCapacityEvent([{ label: 'Day 1' }, { label: 'Day 2' }], { capacity: null });
    // An archived day of the capacity event is still a venue day: copied too.
    await prisma.eventDay.update({ where: { id: threeDay.days['Friday']! }, data: { isArchived: true } });

    const updated = await prisma.$executeRawUnsafe(scopedBackfill([threeDay.eventId, noCapacity.eventId]));
    expect(updated).toBe(2);

    const capacities = async (eventId: string) =>
      Object.fromEntries(
        (await prisma.eventDay.findMany({ where: { eventId }, select: { label: true, capacity: true } })).map((d) => [d.label, d.capacity])
      );
    expect(await capacities(threeDay.eventId)).toEqual({ Friday: 10, Saturday: 10, Sunday: null });
    expect(await capacities(noCapacity.eventId)).toEqual({ 'Day 1': null, 'Day 2': null });
    // The event column is kept as it was.
    expect((await prisma.event.findUniqueOrThrow({ where: { id: threeDay.eventId } })).capacity).toBe(10);
  }, 60_000);

  it('the database refuses a capacity on an online day, and one outside 1 to 100,000', async () => {
    const ev = await createCapacityEvent([{ label: 'Online', online: true }, { label: 'Hall' }]);
    await expect(prisma.eventDay.update({ where: { id: ev.days['Online']! }, data: { capacity: 5 } })).rejects.toThrow(/EventDay_capacity_check/);
    await expect(prisma.eventDay.update({ where: { id: ev.days['Hall']! }, data: { capacity: 0 } })).rejects.toThrow(/EventDay_capacity_check/);
    await expect(prisma.eventDay.update({ where: { id: ev.days['Hall']! }, data: { capacity: 100_001 } })).rejects.toThrow(/EventDay_capacity_check/);
    await prisma.eventDay.update({ where: { id: ev.days['Hall']! }, data: { capacity: 100_000 } });
  }, 60_000);
});
