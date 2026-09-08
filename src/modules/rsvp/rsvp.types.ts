export interface SubmitRsvpDto {
  token: string;
  attending: boolean;
  attendingDayIds?: string[];
  rsvpResponses?: { rsvpFieldId: string; value: string }[];
  ticketId?: string;
  ticketQuantity?: number;
  paymentRef?: string;
  plusOneNames?: string[];
  // A guest imported by phone/email alone supplies their name here — the
  // only moment they're ever asked. Blank/omitted leaves existing data
  // alone (see rsvp.service.ts's submit()); never erases a name the
  // organiser already set.
  firstName?: string;
  surname?: string;
  // Lets a guest add the contact channel they weren't imported with (or
  // correct the one they have) — see guest-validation.util.ts's
  // assertExactlyOneContact for why that invariant doesn't apply here.
  email?: string;
  phoneNumber?: string;
}
