import { type PlatformRole, type DeliveryMethod } from '@prisma/client';
import { type ReminderSkipReason } from './invite-reminder.util.js';
export interface InviteDispatchFailure {
    guestId: string;
    name: string;
    contact: string;
    reason: string;
}
export interface SendInvitesResult {
    totalSelected: number;
    sent: number;
    failed: number;
    failures: InviteDispatchFailure[];
}
export interface InviteDispatchOutcome {
    guestId: string;
    name: string;
    contact: string;
    deliveryMethod: DeliveryMethod;
    ok: boolean;
    reason?: string;
}
export interface ReminderSkip {
    guestId: string;
    name: string;
    contact: string;
    reason: ReminderSkipReason;
    message: string;
    nextEligibleAt?: string;
}
export interface SendRemindersResult {
    totalSelected: number;
    sent: number;
    failed: number;
    skipped: number;
    skippedRecentlyReminded: number;
    cooldownHours: number;
    failures: InviteDispatchFailure[];
    skippedGuests: ReminderSkip[];
}
export declare const inviteDispatchService: {
    sendBulk: (eventId: string, guestIds: string[], requestingRole: PlatformRole, tenantId: string | null) => Promise<SendInvitesResult>;
    resend: (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<InviteDispatchOutcome>;
    remindBulk: (eventId: string, guestIds: string[] | undefined, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<SendRemindersResult>;
};
//# sourceMappingURL=invite-dispatch.service.d.ts.map