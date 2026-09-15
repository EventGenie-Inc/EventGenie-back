import prisma from '../../shared/prisma/prisma.client.js';
import { type SmsSendSource } from '@prisma/client';

// Internal accounting table only — no service/router in this phase, it
// exists purely to back assertSmsSendable's two, deliberately-never-
// pooled quota checks (see sms-tier-enforcement.util.ts's header
// comment): the tenant-wide monthly QUOTA, and each event's own
// non-resetting SMS BUNDLE (Event Pass batch).
export const smsSendLogRepository = {
  // eventId + source are threaded through by invite-dispatch.service.ts
  // from the SAME assertSmsSendable call that already decided which pool
  // this batch draws from — never re-derived here, so the log can never
  // disagree with what was actually enforced.
  create: (tenantId: string, eventId: string, inviteId: string, source: SmsSendSource) =>
    prisma.smsSendLog.create({ data: { tenantId, eventId, inviteId, source } }),

  // QUOTA only — a BUNDLE-sourced send (a different, passed event under
  // the same tenant) must never count against this tenant-wide monthly
  // allowance, or the "never fall back, in either direction" rule breaks
  // silently the moment a tenant has both a passed and an unpassed event.
  countForTenantThisMonth: (tenantId: string) => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    return prisma.smsSendLog.count({
      where: { tenantId, source: 'QUOTA', sentAt: { gte: startOfMonth, lt: startOfNextMonth } },
    });
  },

  // BUNDLE only, all-time (bundles do not reset) — feeds a passed
  // event's remaining balance (purchased - used) in both
  // sms-tier-enforcement.util.ts's enforcement and
  // event-pass.service.ts's status display.
  countBundleUsedForEvent: (eventId: string) =>
    prisma.smsSendLog.count({ where: { eventId, source: 'BUNDLE' } }),
};
