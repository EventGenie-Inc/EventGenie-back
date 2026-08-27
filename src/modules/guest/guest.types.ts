// guest.types.ts
export interface CreateGuestDto {
  firstName?: string;
  surname?: string;
  email?: string;
  phoneNumber?: string;
  eventDayIds: string[];
}

// exactOptionalPropertyTypes: `undefined` means "leave this field alone",
// `null` means "explicitly clear it" — needed so a client can switch
// contact type (email -> phone or vice versa) in a single PATCH.
export interface UpdateGuestDto {
  firstName?: string | null;
  surname?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}
