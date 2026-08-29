import { type EventStatus } from '@prisma/client';
export interface EventDayLike {
    date: Date;
    endTime: Date | null;
}
export interface StatusDerivableEvent {
    status: EventStatus;
    eventDays: EventDayLike[];
}
export declare const resolveEffectiveStatus: (event: StatusDerivableEvent) => EventStatus;
export declare const withEffectiveStatus: <T extends StatusDerivableEvent>(event: T) => T;
export declare const assertEventIsPublished: (effectiveStatus: EventStatus) => void;
//# sourceMappingURL=event-status.util.d.ts.map