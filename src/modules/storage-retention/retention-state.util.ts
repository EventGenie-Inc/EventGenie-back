import prisma from '../../shared/prisma/prisma.client.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  NO DELETION WITHOUT A FULL COUNTDOWN (storage-retention.service.ts)
//
//  While storageRetention is off no countdown is shown, so switching it
//  back on must not delete what came due in the meantime. The sweep
//  records when it last ran with the flag on (StorageRetentionState). When
//  it finds that run more than RETENTION_RESUME_GAP_MS ago (or none: the
//  first run after deploy), it records a RESUME, and no retention rule
//  deletes anything until RETENTION_RESUME_GRACE_DAYS after it: every
//  deletion is due at the later of its own time and the resume + 7 days
//  (the floor), and every deletesAt and reminder date reports that. A
//  server down for longer than the gap counts the same: harmless, it only
//  waits.
//
//  Reads (deletesAt) use the same floor: with the last run stale (the
//  flag just switched on, the sweep not yet run), the floor is now + 7
//  days, the date the next sweep will record.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_ID = 'singleton';

// The sweep runs every 15 minutes; a gap this long means it wasn't
// running with the flag on (or the server was down).
export const RETENTION_RESUME_GAP_MS = 6 * 60 * 60 * 1000;
export const RETENTION_RESUME_GRACE_DAYS = 7;

export interface RetentionState {
  lastSweptAt: Date | null;
  resumedAt: Date | null;
}

const isStale = (state: RetentionState | null, now: Date): boolean =>
  !state?.lastSweptAt || now.getTime() - state.lastSweptAt.getTime() > RETENTION_RESUME_GAP_MS;

// The earliest any retention deletion may happen.
export const retentionFloor = (state: RetentionState | null, now: Date): Date => {
  const resumedAt = isStale(state, now) || !state?.resumedAt ? now : state.resumedAt;
  return new Date(resumedAt.getTime() + RETENTION_RESUME_GRACE_DAYS * DAY_MS);
};

// A due date held to the floor.
export const notBeforeFloor = (due: Date, floor: Date): Date => (due < floor ? floor : due);

export const retentionStateRepository = {
  find: (): Promise<RetentionState | null> =>
    prisma.storageRetentionState.findUnique({ where: { id: STATE_ID }, select: { lastSweptAt: true, resumedAt: true } }),

  // The sweep, with the flag on: a resume recorded if the last run is stale
  // (conditional, so two sweeps racing record it at most once each with
  // their own time), then this run. Returns the state after it.
  recordSweep: async (now: Date): Promise<RetentionState> => {
    await prisma.storageRetentionState.upsert({
      where: { id: STATE_ID },
      create: { id: STATE_ID, lastSweptAt: null, resumedAt: null },
      update: {},
    });
    await prisma.storageRetentionState.updateMany({
      where: { id: STATE_ID, OR: [{ lastSweptAt: null }, { lastSweptAt: { lt: new Date(now.getTime() - RETENTION_RESUME_GAP_MS) } }] },
      data: { resumedAt: now },
    });
    return prisma.storageRetentionState.update({
      where: { id: STATE_ID },
      data: { lastSweptAt: now },
      select: { lastSweptAt: true, resumedAt: true },
    });
  },
};

// The floor for a read (deletesAt), or null while the flag is off (no
// countdown at all then).
export const currentRetentionFloor = async (now: Date = new Date()): Promise<Date | null> =>
  isFeatureEnabled('storageRetention') ? retentionFloor(await retentionStateRepository.find(), now) : null;
