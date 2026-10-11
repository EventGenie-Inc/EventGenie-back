import prisma from '../../shared/prisma/prisma.client.js';
import { type DeliveryMethod } from '@prisma/client';

// Append-only audit of every reminder attempt, failures included — no
// update or delete method exists here on purpose (see InviteReminderLog's
// schema comment). Internal to the reminder flow, so no service/router:
// invite-dispatch.service.ts is the only writer. Cooldown is NOT read from
// here — that is Invite.lastRemindedAt, claimed atomically; this table is
// the record of what actually happened.
interface ReminderLogEntry {
  tenantId: string;
  eventId: string;
  inviteId: string;
  deliveryMethod: DeliveryMethod;
  succeeded: boolean;
  failureReason: string | null;
  sentBy: string;
}

export const inviteReminderLogRepository = {
  // A whole reminder batch's rows, in one write.
  createMany: (entries: ReminderLogEntry[]) =>
    entries.length ? prisma.inviteReminderLog.createMany({ data: entries }) : Promise.resolve({ count: 0 }),
};
