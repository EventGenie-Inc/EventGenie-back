// guest.types.ts
export interface CreateGuestDto {
  firstName?: string;
  surname?: string;
  email?: string;
  phoneNumber?: string;
  // The country selected beside the phone field (ISO 3166, e.g. "GB"):
  // a number without a country code is read in it. Default ZA.
  phoneCountry?: string;
  eventDayIds: string[];
  plusOnesAllowed?: number;
}

// exactOptionalPropertyTypes: `undefined` means "leave this field alone",
// `null` means "explicitly clear it" — needed so a client can switch
// contact type (email -> phone or vice versa) in a single PATCH.
export interface UpdateGuestDto {
  firstName?: string | null;
  surname?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  // As on create; read only with phoneNumber.
  phoneCountry?: string;
  plusOnesAllowed?: number;
}
