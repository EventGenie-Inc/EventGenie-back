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
//  WIZARD DRAFT -> EVENT — a legacy invitationTemplate is ignored
//
//  Event.invitationTemplate/invitationConfig were dropped (InvitationDesign
//  replaces them), but a wizard draft saved before that still carries
//  invitationTemplate in its opaque payload. materialize must not read it:
//  passing it to event.create would now be an unknown Prisma argument and
//  the conversion would fail with a 500, stranding the organiser's draft.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

describe('eventDraftService.materialize — legacy invitation fields', () => {
  it('a draft still carrying invitationTemplate (and invitationConfig) converts, and the fields are dropped', async () => {
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

    await eventDraftRepository.upsert(tenant.id, user.id, {
      currentStep: 4,
      payload: {
        name: 'Legacy draft',
        days: [{ label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Somewhere', address: '1 Test Road' }],
        invitationTemplate: 'classic-gold',
        invitationConfig: '{"accent":"#c9a227"}',
      },
    });

    const event = await eventDraftService.materialize(tenant.id, user.id);

    expect(event).toMatchObject({ name: 'Legacy draft', status: 'DRAFT' });
    expect(event!.eventDays[0]).toMatchObject({ location: 'Somewhere', address: '1 Test Road' });
    expect(event).not.toHaveProperty('invitationTemplate');
    expect(event).not.toHaveProperty('invitationConfig');
    expect(await prisma.eventDay.count({ where: { eventId: event!.id } })).toBe(1);
    expect(await eventDraftRepository.findByTenantAndUser(tenant.id, user.id)).toBeNull();
  }, 60000);
});
