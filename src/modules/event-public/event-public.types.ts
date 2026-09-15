// Public self-registration (G2) — a guest supplies only what's needed
// to create a Guest+Invite pair; everything else (day selection,
// custom RSVP fields, plus-ones, tickets) happens on the RSVP form the
// registrant is handed into afterwards via the returned invite token.
export interface RegisterGuestDto {
  firstName: string;
  surname?: string;
  email?: string;
  phoneNumber?: string;
}
