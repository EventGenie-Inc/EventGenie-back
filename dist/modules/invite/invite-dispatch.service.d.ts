import { type PlatformRole, type DeliveryMethod } from '@prisma/client';
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
export declare const inviteDispatchService: {
    sendBulk: (eventId: string, guestIds: string[], requestingRole: PlatformRole, tenantId: string | null) => Promise<SendInvitesResult>;
    resend: (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<InviteDispatchOutcome>;
};
//# sourceMappingURL=invite-dispatch.service.d.ts.map