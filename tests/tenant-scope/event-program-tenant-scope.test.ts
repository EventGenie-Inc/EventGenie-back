import { describe, it, expect, afterEach } from 'vitest';
import { eventProgramService } from '../../src/modules/event-program/event-program.service.js';
import { programItemService } from '../../src/modules/program-item/program-item.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  G3 PREREQUISITES — PART 1
//
//  event-program and program-item did no tenant scoping at all: any
//  EVENT_ADMIN in any tenant could read/edit/archive any event's
//  program by id, and program-item ignored the :eventId in its URL
//  entirely (a programId alone was enough, regardless of tenant or
//  event). This asserts every read/write 404s across tenants, and that
//  an item id reached under the WRONG :eventId (same tenant, confused
//  deputy) 404s too, per STEERING's cross-tenant rule (404, never 403 —
//  confirming a record exists elsewhere is itself a leak).
//
//  FIFO, not LIFO — cleanup is pushed in dependency order (children
//  before the parents they reference).
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const deleteTestProgram = async (programId: string): Promise<void> => {
  await prisma.programItem.deleteMany({ where: { programId } });
  await prisma.eventProgram.delete({ where: { id: programId } });
};

describe('event-program / program-item — tenant scoping (Part 1)', () => {
  it("eventProgramService: another tenant's program 404s on read, update and archive", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    const event = await createTestEvent(ownerTenant.id, ownerUser.id);
    const program = await eventProgramService.create(event.id, ownerUser.id, ownerUser.role, ownerTenant.id, { title: 'Wedding Day' });

    const otherTenant = await createTestTenant();
    const otherUser = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: otherTenant.id });

    cleanup.push(
      () => deleteTestUserRow(otherUser.id),
      () => deleteTestTenant(otherTenant.id),
      () => deleteTestProgram(program.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    await expect(
      eventProgramService.getByEventId(event.id, otherUser.role, otherUser.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      eventProgramService.getById(program.id, otherUser.role, otherUser.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      eventProgramService.update(program.id, otherUser.id, otherUser.role, otherUser.tenantId, { title: 'Hijacked' })
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      eventProgramService.archive(program.id, otherUser.id, otherUser.role, otherUser.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    // Regression guard: the owning tenant can still reach it, and the
    // cross-tenant attempts above never actually mutated the row.
    const found = await eventProgramService.getById(program.id, ownerUser.role, ownerUser.tenantId);
    expect(found.id).toBe(program.id);
    expect(found.title).toBe('Wedding Day');
    expect(found.isArchived).toBe(false);
  }, 30000);

  it("eventProgramService.getById: not found is 404, not a 500 (bare Error regression guard)", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    cleanup.push(() => deleteTestUserRow(ownerUser.id), () => deleteTestTenant(ownerTenant.id));

    const err = await eventProgramService.getById('does-not-exist', ownerUser.role, ownerUser.tenantId).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404 });
    expect(err.name).toBe('HttpError');
  });

  it("programItemService: another tenant's items 404 on read, update and archive", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    const event = await createTestEvent(ownerTenant.id, ownerUser.id);
    const program = await eventProgramService.create(event.id, ownerUser.id, ownerUser.role, ownerTenant.id, {});
    const item = await programItemService.create(event.id, program.id, ownerUser.id, ownerUser.role, ownerTenant.id, {
      title: 'Ceremony',
      startTime: '2027-06-01T14:00:00',
      order: 1,
    });

    const otherTenant = await createTestTenant();
    const otherUser = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: otherTenant.id });

    cleanup.push(
      () => deleteTestUserRow(otherUser.id),
      () => deleteTestTenant(otherTenant.id),
      () => deleteTestProgram(program.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    await expect(
      programItemService.getAll(event.id, program.id, otherUser.role, otherUser.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      programItemService.getById(item.id, event.id, program.id, otherUser.role, otherUser.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      programItemService.update(item.id, event.id, program.id, otherUser.id, otherUser.role, otherUser.tenantId, { title: 'Hijacked' })
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      programItemService.archive(item.id, event.id, program.id, otherUser.id, otherUser.role, otherUser.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    // Regression guard: unchanged for the owning tenant.
    const found = await programItemService.getById(item.id, event.id, program.id, ownerUser.role, ownerUser.tenantId);
    expect(found.title).toBe('Ceremony');
    expect(found.isArchived).toBe(false);
  }, 30000);

  it("programItemService: an item id under the WRONG :eventId 404s, even within the same tenant", async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });

    const event1 = await createTestEvent(tenant.id, user.id);
    const program1 = await eventProgramService.create(event1.id, user.id, user.role, tenant.id, {});
    const item1 = await programItemService.create(event1.id, program1.id, user.id, user.role, tenant.id, {
      title: 'Speeches',
      startTime: '2027-06-01T18:00:00',
      order: 1,
    });

    // A second event in the SAME tenant — program-item previously
    // ignored :eventId entirely, so a programId/itemId from event1
    // would have been reachable through event2's URL too.
    const event2 = await createTestEvent(tenant.id, user.id);
    const program2 = await eventProgramService.create(event2.id, user.id, user.role, tenant.id, {});

    cleanup.push(
      () => deleteTestProgram(program2.id),
      () => deleteTestEvent(event2.id),
      () => deleteTestProgram(program1.id),
      () => deleteTestEvent(event1.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    // Right tenant, right programId, WRONG eventId in the URL.
    await expect(
      programItemService.getById(item1.id, event2.id, program1.id, user.role, user.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      programItemService.getAll(event2.id, program1.id, user.role, user.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    // Right tenant, right eventId (event1), but item1 requested under
    // event2's program id — item belongs to a different program.
    await expect(
      programItemService.getById(item1.id, event1.id, program2.id, user.role, user.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });

    // Correct triple still resolves.
    const found = await programItemService.getById(item1.id, event1.id, program1.id, user.role, user.tenantId);
    expect(found.id).toBe(item1.id);
  }, 30000);

  it("programItemService.create: eventDayId from a DIFFERENT event is rejected 422", async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });

    const event1 = await createTestEvent(tenant.id, user.id);
    const program1 = await eventProgramService.create(event1.id, user.id, user.role, tenant.id, {});

    const event2 = await createTestEvent(tenant.id, user.id);
    const foreignDay = await createTestEventDay(event2.id, user.id, 'Day 1');

    cleanup.push(
      () => prisma.eventDay.delete({ where: { id: foreignDay.id } }),
      () => deleteTestEvent(event2.id),
      () => deleteTestProgram(program1.id),
      () => deleteTestEvent(event1.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    await expect(
      programItemService.create(event1.id, program1.id, user.id, user.role, user.tenantId, {
        title: 'Cake cutting',
        startTime: '2027-06-01T20:00:00',
        order: 1,
        eventDayId: foreignDay.id,
      })
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
