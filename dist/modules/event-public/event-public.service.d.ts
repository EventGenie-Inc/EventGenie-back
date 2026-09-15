import { type RegisterGuestDto } from './event-public.types.js';
export declare const eventPublicService: {
    viewByShareToken: (shareToken: string) => Promise<{
        name: string;
        description: string | null;
        hostName: string | null;
        location: string;
        address: string | null;
        coverImageUrl: string | null;
        rsvpDeadline: Date | null;
        eventDays: {
            id: string;
            label: string;
            date: Date;
            startTime: Date | null;
            endTime: Date | null;
        }[];
        isPublic: boolean;
        isPublished: boolean;
        isCancelled: boolean;
        isCompleted: boolean;
        isRsvpDeadlinePassed: boolean;
        canRegister: boolean;
    }>;
    register: (shareToken: string, data: RegisterGuestDto) => Promise<{
        token: string;
        isExistingRegistration: boolean;
    }>;
};
//# sourceMappingURL=event-public.service.d.ts.map