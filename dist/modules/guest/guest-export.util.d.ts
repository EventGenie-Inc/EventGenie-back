interface TemplateEvent {
    id: string;
    name: string;
}
interface ExportEventDay {
    id: string;
    label: string;
}
interface ExportRsvpField {
    id: string;
    label: string;
}
interface ExportInvite {
    status: string;
    inviteEventDay: {
        eventDay: {
            id: string;
            label: string;
        };
    }[];
    attendances: {
        eventDayId: string;
    }[];
    rsvpResponses: {
        rsvpFieldId: string;
        value: string;
    }[];
}
export interface ExportGuest {
    id: string;
    firstName: string | null;
    surname: string | null;
    email: string | null;
    phoneNumber: string | null;
    hostGuestId: string | null;
    hostGuest: {
        firstName: string | null;
        surname: string | null;
    } | null;
    invites: ExportInvite[];
}
export declare const buildGuestExportWorkbook: (event: TemplateEvent, eventDays: ExportEventDay[], rsvpFields: ExportRsvpField[], guests: ExportGuest[]) => Promise<{
    buffer: Buffer;
    filename: string;
}>;
export {};
//# sourceMappingURL=guest-export.util.d.ts.map