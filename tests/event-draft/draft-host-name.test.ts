import { describe, it, expect, afterEach } from 'vitest';
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
//  WIZARD DRAFT -> EVENT — hostName is carried through
//
//  materialize used to drop hostName, so an organiser who typed a host in
//  the wizard got an event with no host line on the invitation/RSVP page.
//  It must be stored as typed, and null when absent or blank.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

describe('eventDraftService.materialize — hostName', () => {
  it('a draft with a hostName produces an event with it; absent or blank produces null', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    cleanup.push(
      async () => { await prisma.eventDraft.deleteMany({ where: { createdByUserId: user.id } }); },
      async () => {
        const events = await prisma.event.findMany({ where: { tenantId: tenant.id }, select: { id: true } });
        for (const { id } of events) {
          await prisma.eventDay.deleteMany({ where: { eventId: id } });
          await deleteTestEvent(id);
        }
      },
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const convert = async (extra: Record<string, unknown>) => {
      await eventDraftRepository.upsert(tenant.id, user.id, {
        currentStep: 4,
        payload: { name: 'Host test', days: [{ label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Somewhere', address: '1 Test Road' }], ...extra },
      });
      const event = await eventDraftService.materialize(tenant.id, user.id);
      return prisma.event.findUniqueOrThrow({ where: { id: event!.id } });
    };

    expect((await convert({ hostName: 'The Mashilo Family' })).hostName).toBe('The Mashilo Family');
    expect((await convert({})).hostName).toBeNull();
    expect((await convert({ hostName: '   ' })).hostName).toBeNull();
  }, 60000);
});
