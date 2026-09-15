export interface CreateGuestDto {
    firstName?: string;
    surname?: string;
    email?: string;
    phoneNumber?: string;
    eventDayIds: string[];
    plusOnesAllowed?: number;
}
export interface UpdateGuestDto {
    firstName?: string | null;
    surname?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
    plusOnesAllowed?: number;
}
//# sourceMappingURL=guest.types.d.ts.map