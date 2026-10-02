export declare const assertNoDuplicateDayLabel: (eventId: string, label: string, excludeDayId?: string) => Promise<void>;
export declare const isDayLabelUniqueViolation: (err: unknown) => boolean;
export declare const requireDayLabel: (label: unknown) => string;
export declare const requireDayDate: (date: unknown, label: string) => Date;
//# sourceMappingURL=event-day-validation.util.d.ts.map