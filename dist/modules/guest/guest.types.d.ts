export interface CreateGuestDto {
    firstName?: string;
    surname?: string;
    email?: string;
    phoneNumber?: string;
    eventDayIds: string[];
}
export interface UpdateGuestDto {
    firstName?: string | null;
    surname?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
}
//# sourceMappingURL=guest.types.d.ts.map