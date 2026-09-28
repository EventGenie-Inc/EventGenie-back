export declare const buildInviteRsvpLink: (token: string) => string;
export declare const buildInviteEmailSubject: (eventName: string) => string;
export declare const buildInviteEmailHtml: (eventName: string, location: string, dateLabel: string | null, rsvpLink: string) => string;
export declare const buildInviteSmsBody: (eventName: string, rsvpLink: string) => string;
export declare const buildReminderEmailSubject: (eventName: string) => string;
export declare const buildReminderEmailHtml: (eventName: string, location: string, dateLabel: string | null, rsvpDeadline: Date | null, rsvpLink: string) => string;
export declare const buildReminderSmsBody: (eventName: string, rsvpLink: string, rsvpDeadline: Date | null) => string;
//# sourceMappingURL=invite-message.util.d.ts.map