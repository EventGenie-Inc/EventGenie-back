import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type SmsSendSource } from '@prisma/client';

// Internal accounting table only — no service/router, it exists purely to
// back assertSmsSendable's two, deliberately-never-pooled quota checks (see
// sms-tier-enforcement.util.ts's header comment): the tenant-wide monthly
// QUOTA, and each event's own non-resetting SMS BUNDLE (Event Pass batch).
//
// Everything counts PARTS, not messages: a row carries the parts SMSPortal
// said the text cost. And a text still in the send queue (QUEUED or
// SENDING) is RESERVED: one part, since every text is built to fit one
// (invite-message.util.ts), so two sends a moment apart can't both spend
// the same last credits.
export const smsSendLogRepository = {
  // Written by the email-send worker, in the transaction that marks the
  // text sent, with the source the SAME assertSmsSendable call decided
  // when it was queued (EmailSendItem.smsSource) — never re-derived here,
  // so the log can never disagree with what was actually enforced.
  // emailSendItemId is unique: a text is never logged twice.
  create: (
    tx: Prisma.TransactionClient,
    data: { tenantId: string; eventId: string; inviteId: string; source: SmsSendSource; parts: number; emailSendItemId: string }
  ) => tx.smsSendLog.create({ data }),

  // QUOTA only — a BUNDLE-sourced send (a different, passed event under
  // the same tenant) must never count against this tenant-wide monthly
  // allowance, or the "never fall back, in either direction" rule breaks
  // silently the moment a tenant has both a passed and an unpassed event.
  // Parts sent this month, plus texts queued against the quota.
  countForTenantThisMonth: async (tenantId: string): Promise<number> => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [sent, reserved] = await Promise.all([
      prisma.smsSendLog.aggregate({
        where: { tenantId, source: 'QUOTA', sentAt: { gte: startOfMonth, lt: startOfNextMonth } },
        _sum: { parts: true },
      }),
      prisma.emailSendItem.count({
        where: { channel: 'SMS', smsSource: 'QUOTA', status: { in: ['QUEUED', 'SENDING'] }, invite: { event: { tenantId } } },
      }),
    ]);
    return (sent._sum.parts ?? 0) + reserved;
  },

  // BUNDLE only, all-time (bundles do not reset): parts sent. Feeds a
  // passed event's balance on event-pass.service.ts's status display.
  countBundleUsedForEvent: async (eventId: string): Promise<number> => {
    const sent = await prisma.smsSendLog.aggregate({ where: { eventId, source: 'BUNDLE' }, _sum: { parts: true } });
    return sent._sum.parts ?? 0;
  },

  // Parts sent from the bundle plus texts queued against it: what
  // enforcement (sms-tier-enforcement.util.ts) subtracts from the purchase.
  countBundleCommittedForEvent: async (eventId: string): Promise<number> => {
    const [sent, reserved] = await Promise.all([
      smsSendLogRepository.countBundleUsedForEvent(eventId),
      prisma.emailSendItem.count({ where: { eventId, channel: 'SMS', smsSource: 'BUNDLE', status: { in: ['QUEUED', 'SENDING'] } } }),
    ]);
    return sent + reserved;
  },
};
