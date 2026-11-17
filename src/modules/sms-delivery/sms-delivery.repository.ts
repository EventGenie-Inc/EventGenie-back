import { type Prisma, type SmsDeliveryStatus } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;

const REASON_MAX_LENGTH = 500;

const itemSelect = {
  id: true,
  sendId: true,
  eventId: true,
  inviteId: true,
  kind: true,
  status: true,
  smsSource: true,
  providerCallAt: true,
  providerMessageId: true,
  deliveryStatus: true,
  send: { select: { createdBy: true } },
  invite: { select: { deliveryMethod: true, deliveredAt: true, event: { select: { tenantId: true } } } },
} satisfies Prisma.EmailSendItemSelect;

export type ReportedItem = Prisma.EmailSendItemGetPayload<{ select: typeof itemSelect }>;

export const smsDeliveryRepository = {
  // The text a report is about: by our own id (the customerId we gave
  // SMSPortal), else by SMSPortal's eventId for the send. Texts only.
  findItem: async (customerId: string | null, providerMessageId: string | null): Promise<ReportedItem | null> => {
    if (customerId) {
      const byId = await prisma.emailSendItem.findFirst({ where: { id: customerId, channel: 'SMS' }, select: itemSelect });
      if (byId) return byId;
    }
    if (providerMessageId) {
      return prisma.emailSendItem.findFirst({ where: { providerMessageId, channel: 'SMS' }, select: itemSelect });
    }
    return null;
  },

  // Locks the item's row for the rest of the transaction, so two reports
  // for the same text (a retried webhook) are applied one after the other.
  lockItem: (tx: Tx, id: string) => tx.$queryRaw`SELECT "id" FROM "EmailSendItem" WHERE "id" = ${id} FOR UPDATE`,

  findItemTx: (tx: Tx, id: string) => tx.emailSendItem.findUnique({ where: { id }, select: itemSelect }),

  setDelivery: (tx: Tx, id: string, status: SmsDeliveryStatus, reason: string | null, at: Date) =>
    tx.emailSendItem.update({
      where: { id },
      data: { deliveryStatus: status, deliveryStatusAt: at, deliveryError: reason?.slice(0, REASON_MAX_LENGTH) ?? null },
    }),

  // An unconfirmed text (FAILED after an unclear answer) that its report
  // proves went: SENT after all.
  confirmSent: (tx: Tx, id: string, data: { at: Date; providerMessageId: string | null; parts: number }) =>
    tx.emailSendItem.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: data.at,
        finishedAt: null,
        lastError: null,
        providerMessageId: data.providerMessageId,
        smsParts: data.parts,
      },
    }),

  // Counted once only: the item id is unique on SmsSendLog.
  logSentOnce: (
    tx: Tx,
    data: { tenantId: string; eventId: string; inviteId: string; source: 'QUOTA' | 'BUNDLE'; parts: number; emailSendItemId: string }
  ) => tx.smsSendLog.createMany({ data: [data], skipDuplicates: true }),

  markInviteDelivered: (tx: Tx, inviteId: string, at: Date) =>
    tx.invite.updateMany({ where: { id: inviteId, deliveredAt: null }, data: { deliveredAt: at } }),

  logReminderSent: (tx: Tx, data: { tenantId: string; eventId: string; inviteId: string; sentBy: string }) =>
    tx.inviteReminderLog.create({ data: { ...data, deliveryMethod: 'SMS', succeeded: true, failureReason: null } }),

  // Whether this item is the invite's most recent text that was sent to
  // the provider: only that one's status is the guest's.
  isLatestTextFor: async (tx: Tx, inviteId: string, itemId: string): Promise<boolean> => {
    const latest = await tx.emailSendItem.findFirst({
      where: { inviteId, channel: 'SMS', providerCallAt: { not: null } },
      orderBy: { providerCallAt: 'desc' },
      select: { id: true },
    });
    return latest?.id === itemId;
  },

  setInviteSmsStatus: (tx: Tx, inviteId: string, status: SmsDeliveryStatus, reason: string | null, at: Date) =>
    tx.invite.update({
      where: { id: inviteId },
      data: { smsStatus: status, smsStatusAt: at, smsStatusReason: reason?.slice(0, REASON_MAX_LENGTH) ?? null },
    }),
};
