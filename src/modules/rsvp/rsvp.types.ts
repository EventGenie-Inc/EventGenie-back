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
  // Lets a guest add the contact channel they weren't imported with, or
  // correct/remove one they have — see rsvp.service.ts's submit(). Omitted
  // or blank = leave it alone; null = remove it (refused with 422 if it is
  // their only contact); a value = set it (validated and normalised the
  // way guest import does, 422 if invalid). See guest-validation.util.ts's
  // assertExactlyOneContact for why the "not both" rule doesn't apply here.
  email?: string | null;
  phoneNumber?: string | null;
}

export interface QuoteTicketDto {
  token: string;
  ticketId: string;
  quantity: number;
}
