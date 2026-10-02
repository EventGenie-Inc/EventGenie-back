import { describe, it, expect, afterEach } from 'vitest';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestGuestWithInvite,
  deleteTestGuest,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FIX 2
//
//  rsvp.service.ts's submit() must return an explicit guest-facing shape,
//  never the raw Invite/TicketPurchase rows the transaction works with
//  internally — see submit()'s own comment on what those rows carry
//  (editToken, eventId, guestId, deliveryMethod, createdBy/updatedBy on
//  Invite; commissionCents, ticketPriceCents, paymentRef on
//  TicketPurchase). This asserts the EXACT key set, not just "the
//  dangerous fields are gone" — an allowlist regresses silently if a new
//  raw field is ever added back without anyone noticing.
// ─────────────────────────────────────────

// FIFO, not LIFO — cleanup is pushed in dependency order (children
// before the parents they reference).
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

describe('rsvp.service.ts submit() — response shape', () => {
  it('has no fields beyond the explicit guest-facing shape (decline, no ticket)', async () => {
    const tenant = await createTestTenant();
    const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, organiser.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, organiser.id, []);
    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(organiser.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await rsvpService.submit({ token: invite.token, attending: false });

    expect(Object.keys(result).sort()).toEqual(
      ['attendances', 'invite', 'paymentAction', 'refundNotice', 'rsvpResponses', 'ticketPurchase'].sort()
    );
    expect(Object.keys(result.invite).sort()).toEqual(['id', 'status', 'used', 'usedAt'].sort());

    // The dangerous fields specifically — belt-and-suspenders on top of
    // the exact-key-set check above, naming exactly what this fix was for.
    expect(result.invite).not.toHaveProperty('editToken');
    expect(result.invite).not.toHaveProperty('token');
    expect(result.invite).not.toHaveProperty('eventId');
    expect(result.invite).not.toHaveProperty('guestId');
    expect(result.invite).not.toHaveProperty('deliveryMethod');
    expect(result.invite).not.toHaveProperty('createdBy');
    expect(result.invite).not.toHaveProperty('updatedBy');

    expect(result.invite.id).toBe(invite.id);
    expect(result.invite.status).toBe('DECLINED');
    expect(result.ticketPurchase).toBeNull();
  });
});
