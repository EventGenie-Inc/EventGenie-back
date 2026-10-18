import { type Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { guestRepository } from './guest.repository.js';

// ─────────────────────────────────────────
//  GUEST CEILING — a hard safety limit in code, whatever the plan says
//
//  No event ever has more than MAX_GUESTS_PER_EVENT live guests, plus-ones
//  included. It is checked AFTER the plan's own limit (assertGuestsCreatable),
//  so an organiser on a limited plan still hears about their plan first, and
//  a plan left "unlimited" (maxGuestsPerEvent null) can never take an event
//  past it. Unlike the plan's limit, it counts plus-ones: it bounds the rows
//  an event holds (sends, exports, check-in lists), not what was sold.
//
//  Every path that makes a live guest goes through it: organiser add,
//  import, restoring an archived guest, public self-registration (as FULL /
//  PARTY_TOO_LARGE, registration-rules.util.ts) and plus-ones named at RSVP
//  (rsvp.service.ts). Organiser paths answer 422 EVENT_GUEST_CEILING; guest
//  paths answer with their own "event is full" wording and code, never this
//  number (STEERING "Guest-facing responses").
// ─────────────────────────────────────────

export const MAX_GUESTS_PER_EVENT = 5000;
export const EVENT_GUEST_CEILING = 'EVENT_GUEST_CEILING';

// True when `additional` more guests would take the event past the ceiling.
export const exceedsGuestCeiling = (currentTotal: number, additional: number): boolean =>
  currentTotal + additional > MAX_GUESTS_PER_EVENT;

// Organiser-facing: add, import and restore.
export const assertWithinGuestCeiling = async (
  eventId: string,
  additional: number,
  tx?: Prisma.TransactionClient
): Promise<void> => {
  const current = await guestRepository.countAllForEvent(eventId, tx);
  if (!exceedsGuestCeiling(current, additional)) return;
  const room = Math.max(0, MAX_GUESTS_PER_EVENT - current);
  throw new HttpError(
    422,
    `An event can have at most ${MAX_GUESTS_PER_EVENT.toLocaleString('en-US')} guests, plus-ones included. ` +
      `This event has ${current.toLocaleString('en-US')}, and this would add ${additional.toLocaleString('en-US')}` +
      (room > 0 ? ` (there is room for ${room.toLocaleString('en-US')} more).` : '.'),
    EVENT_GUEST_CEILING
  );
};
