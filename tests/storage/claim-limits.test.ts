import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { type Prisma } from '@prisma/client';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, prisma } from '../helpers/team.js';
import { storedFileRepository } from '../../src/modules/storage/stored-file.repository.js';
import { emailSendRepository } from '../../src/modules/email-send/email-send.repository.js';

// ─────────────────────────────────────────
//  A CLAIM OF n NEVER TAKES MORE THAN n
//
//  Both worker claims (stored-file.repository.ts's and
//  email-send.repository.ts's claimDue) take due rows with a LIMIT and FOR
//  UPDATE SKIP LOCKED. Written as `UPDATE ... WHERE id IN (SELECT ... LIMIT
//  n FOR UPDATE SKIP LOCKED)`, a plan that runs the subquery once per outer
//  row (a nested-loop semi join, chosen when a table's statistics are
//  stale: new, or emptied and refilled) re-runs it after the UPDATE has
//  changed some rows; each re-run skips those and returns the next ones, so
//  the claim keeps growing. With the rows in claim order on disk (a queue's
//  normal state) a claim of 20 took all 60 due rows.
//
//  The plan is pinned here (SET LOCAL, in the claim's own transaction), so
//  the test fails on the old form every time rather than only when the
//  statistics happen to be stale. Picked in a MATERIALIZED CTE, which runs
//  once, the claim is n at most whatever the plan: what comes back, and
//  what was actually leased in the table.
// ─────────────────────────────────────────

const DUE = 60;
const LIMITS = [1, 7, 20];

let tenantId: string;
let eventId: string;
let fileIds: string[] = [];

// The plan that re-runs the subquery per outer row: no hash or merge join,
// no hash aggregate, sort or materialize to run it once instead.
const withPinnedPlan = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(async (tx) => {
    for (const setting of ['enable_hashjoin', 'enable_mergejoin', 'enable_hashagg', 'enable_material', 'enable_sort']) {
      await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
    }
    return fn(tx);
  });

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  const organiser = await createActor('TENANT_ADMIN', tenantId);
  const { event } = await createEventWithDay(tenantId, organiser.id, `Claims ${randomUUID()}`);
  eventId = event.id;
  const base = Date.now() - 60 * 60 * 1000;

  // 60 files due for deletion, written oldest first: on disk in claim order.
  const files = Array.from({ length: DUE }, (_, i) => ({
    id: randomUUID(), publicId: `claims/${randomUUID()}`, resourceType: 'IMAGE' as const, kind: 'COVER' as const, tenantId,
    status: 'DELETE_REQUESTED' as const, deleteRequestedAt: new Date(base + i * 1000),
  }));
  await prisma.storedFile.createMany({ data: files });
  fileIds = files.map((f) => f.id);

  // 60 emails due to send, also oldest first.
  const guests = Array.from({ length: DUE }, () => ({ guestId: randomUUID(), inviteId: randomUUID() }));
  await prisma.guest.createMany({ data: guests.map((g, i) => ({ id: g.guestId, eventId, firstName: `G${i}`, email: `claims-${randomUUID()}@test.invalid` })) });
  await prisma.invite.createMany({
    data: guests.map((g) => ({
      id: g.inviteId, eventId, guestId: g.guestId, token: `claims-${randomUUID()}`, deliveryMethod: 'EMAIL' as const, createdBy: organiser.id, updatedBy: organiser.id,
    })),
  });
  const send = await prisma.emailSend.create({ data: { eventId, kind: 'INVITATION', createdBy: organiser.id } });
  await prisma.emailSendItem.createMany({
    data: guests.map((g, i) => ({ sendId: send.id, eventId, kind: 'INVITATION' as const, inviteId: g.inviteId, nextAttemptAt: new Date(base + i * 1000) })),
  });
}, 60_000);

afterAll(async () => {
  await prisma.storedFile.deleteMany({ where: { id: { in: fileIds } } });
  await deleteTenantsDeep([tenantId]);
}, 60_000);

describe('a claim of n, on the plan that re-runs the subquery', () => {
  it('stored files: never returns or leases more than n', async () => {
    let taken = 0;
    for (const limit of LIMITS) {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + 10 * 60 * 1000 + taken);
      const { returned, leased } = await withPinnedPlan(async (tx) => ({
        returned: (await storedFileRepository.claimDue(now, leaseUntil, limit, fileIds, tx)).length,
        leased: await tx.storedFile.count({ where: { id: { in: fileIds }, nextDeleteAttemptAt: leaseUntil } }),
      }));
      expect({ limit, returned, leased }).toEqual({ limit, returned: limit, leased: limit });
      taken += limit;
    }
    // Each file taken once: the leases add up to what was asked for.
    expect(await prisma.storedFile.count({ where: { id: { in: fileIds }, nextDeleteAttemptAt: { gt: new Date() } } })).toBe(taken);
  });

  it('queued emails: never returns or leases more than n', async () => {
    let taken = 0;
    for (const limit of LIMITS) {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000 + taken);
      const { returned, leased } = await withPinnedPlan(async (tx) => ({
        returned: (await emailSendRepository.claimDue(now, leaseUntil, limit, eventId, tx)).length,
        leased: await tx.emailSendItem.count({ where: { eventId, leaseUntil } }),
      }));
      expect({ limit, returned, leased }).toEqual({ limit, returned: limit, leased: limit });
      taken += limit;
    }
    expect(await prisma.emailSendItem.count({ where: { eventId, status: 'SENDING' } })).toBe(taken);
  });
});
