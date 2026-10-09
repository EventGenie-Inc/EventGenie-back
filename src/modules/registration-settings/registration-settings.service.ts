import { type PlatformRole } from '@prisma/client';
import { eventService } from '../event/event.service.js';
import { resolveGuestLimit } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import { eventPublicRepository } from '../event-public/event-public.repository.js';
import {
  resolveRegistrationState,
  normalizeEmailDomain,
  isValidEmailDomain,
} from '../event-public/registration-rules.util.js';
import { isValidPlusOnesAllowed, MAX_PLUS_ONES_ALLOWED } from '../guest/guest-validation.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { registrationSettingsRepository, type RegistrationSettingsWrite } from './registration-settings.repository.js';
import { type UpdateRegistrationSettingsDto, type RegistrationSettingsView } from './registration-settings.types.js';

// The organiser's side of public self-registration: who may register
// (email domains), how many (a cap), until when (a closing date), how many
// plus-ones each registrant may bring, and which days are open.
//
// Every read and write gates on eventService.getScopedWithPass first:
// tenant scoping and the assignment lock (a locked EVENT_ADMIN gets a 404
// for an event they aren't assigned to), plus the Event Pass the plan's
// guest limit needs.

type ScopedEvent = Awaited<ReturnType<typeof eventService.getScopedWithPass>>;

const MAX_EMAIL_DOMAINS = 20;

// One per refusal, so the settings form marks the field it belongs to.
export const REGISTRATION_SETTINGS_ERROR_CODES = {
  DOMAIN_INVALID: 'REGISTRATION_SETTINGS_DOMAIN_INVALID',
  TOO_MANY_DOMAINS: 'REGISTRATION_SETTINGS_TOO_MANY_DOMAINS',
  CAP_INVALID: 'REGISTRATION_SETTINGS_CAP_INVALID',
  CAP_ABOVE_PLAN_LIMIT: 'REGISTRATION_SETTINGS_CAP_ABOVE_PLAN_LIMIT',
  CLOSES_AT_INVALID: 'REGISTRATION_SETTINGS_CLOSES_AT_INVALID',
  CLOSES_AT_AFTER_DEADLINE: 'REGISTRATION_SETTINGS_CLOSES_AT_AFTER_DEADLINE',
  PLUS_ONES_INVALID: 'REGISTRATION_SETTINGS_PLUS_ONES_INVALID',
  OPEN_DAY_UNKNOWN: 'REGISTRATION_SETTINGS_OPEN_DAY_UNKNOWN',
  NO_OPEN_DAYS: 'REGISTRATION_SETTINGS_NO_OPEN_DAYS',
} as const;

const CODES = REGISTRATION_SETTINGS_ERROR_CODES;

const toView = async (event: ScopedEvent): Promise<RegistrationSettingsView> => {
  const [seats, { limit }] = await Promise.all([eventPublicRepository.countSeats(event.id), resolveGuestLimit(event)]);
  const days = [...event.eventDays].sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    allowedEmailDomains: event.registrationEmailDomains,
    cap: event.registrationCap,
    closesAt: event.registrationClosesAt,
    plusOnesAllowed: event.registrationPlusOnesAllowed,
    days: days.map((d) => ({ id: d.id, label: d.label, date: d.date, openForRegistration: d.openForRegistration })),
    registeredCount: seats.registeredSeats,
    planGuestLimit: limit,
    // getScopedWithPass's status is already the effective one.
    registration: resolveRegistrationState({ ...event, eventDays: days }, seats, limit),
  };
};

const parseDomains = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((d) => typeof d === 'string')) {
    throw new HttpError(400, 'allowedEmailDomains must be a list of email domains, e.g. ["company.co.za"].');
  }
  const domains = [...new Set((value as string[]).map(normalizeEmailDomain).filter((d) => d.length > 0))];
  const invalid = (value as string[]).find((raw) => {
    const d = normalizeEmailDomain(raw);
    return d.length > 0 && !isValidEmailDomain(d);
  });
  if (invalid !== undefined) {
    throw new HttpError(
      422,
      `'${invalid.trim()}' isn't an email domain. Use the part after the @, for example company.co.za.`,
      CODES.DOMAIN_INVALID
    );
  }
  if (domains.length > MAX_EMAIL_DOMAINS) {
    throw new HttpError(422, `You can allow at most ${MAX_EMAIL_DOMAINS} email domains.`, CODES.TOO_MANY_DOMAINS);
  }
  return domains;
};

export const registrationSettingsService = {
  get: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<RegistrationSettingsView> =>
    toView(await eventService.getScopedWithPass(eventId, requestingRole, tenantId)),

  update: async (
    eventId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: UpdateRegistrationSettingsDto
  ): Promise<RegistrationSettingsView> => {
    const event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    if (event.status === 'CANCELLED') {
      throw new HttpError(409, "This event has been cancelled, so its registration settings can't be changed.");
    }
    if (typeof data !== 'object' || data === null) throw new HttpError(400, 'Send the registration settings as an object.');

    const write: RegistrationSettingsWrite = {};

    if (data.allowedEmailDomains !== undefined) {
      write.registrationEmailDomains = data.allowedEmailDomains === null ? [] : parseDomains(data.allowedEmailDomains);
    }

    if (data.cap !== undefined) {
      if (data.cap === null) {
        write.registrationCap = null;
      } else {
        if (typeof data.cap !== 'number' || !Number.isInteger(data.cap) || data.cap < 1) {
          throw new HttpError(
            422,
            'The registration cap must be a whole number of 1 or more, or empty for no cap.',
            CODES.CAP_INVALID
          );
        }
        // Never beyond what the plan (or this event's pass) allows. Read at
        // runtime, so a changed tier config is followed.
        const guestLimit = await resolveGuestLimit(event);
        if (guestLimit.limit !== null && data.cap > guestLimit.limit) {
          const source = guestLimit.boundByPass
            ? `This event's ${event.eventPass!.passTier} pass allows ${guestLimit.limit} guests`
            : `The ${guestLimit.tenantTier} plan allows ${guestLimit.limit} guests per event`;
          throw new HttpError(
            422,
            `${source}, so the registration cap can be at most ${guestLimit.limit}.`,
            CODES.CAP_ABOVE_PLAN_LIMIT
          );
        }
        write.registrationCap = data.cap;
      }
    }

    if (data.closesAt !== undefined) {
      if (data.closesAt === null || data.closesAt === '') {
        write.registrationClosesAt = null;
      } else {
        const closesAt = typeof data.closesAt === 'string' ? parseClientDateTime(data.closesAt) : null;
        if (!closesAt || Number.isNaN(closesAt.getTime())) {
          throw new HttpError(422, 'Enter a valid closing date for registration.', CODES.CLOSES_AT_INVALID);
        }
        // A registrant becomes a guest who can change their answer only
        // until the RSVP deadline, so registration can't outlast it.
        if (event.rsvpDeadline && closesAt > event.rsvpDeadline) {
          throw new HttpError(
            422,
            `Registration can't close after the RSVP deadline (${formatGuestDate(event.rsvpDeadline)}). ` +
              'Choose an earlier date, or leave it empty to close at the deadline.',
            CODES.CLOSES_AT_AFTER_DEADLINE
          );
        }
        write.registrationClosesAt = closesAt;
      }
    }

    if (data.plusOnesAllowed !== undefined) {
      // Each registrant's guest gets this as their allowance, so it follows
      // the guest rule: 0 to MAX_PLUS_ONES_ALLOWED.
      if (!isValidPlusOnesAllowed(data.plusOnesAllowed)) {
        throw new HttpError(
          422,
          `Plus-ones per registrant must be a whole number from 0 to ${MAX_PLUS_ONES_ALLOWED}.`,
          CODES.PLUS_ONES_INVALID
        );
      }
      write.registrationPlusOnesAllowed = data.plusOnesAllowed;
    }

    let openDayIds: string[] | null = null;
    if (data.openDayIds !== undefined) {
      if (!Array.isArray(data.openDayIds) || !data.openDayIds.every((id) => typeof id === 'string')) {
        throw new HttpError(400, 'openDayIds must be a list of event day ids.');
      }
      const liveDayIds = new Set(event.eventDays.map((d) => d.id));
      openDayIds = [...new Set(data.openDayIds as string[])];
      // A day of another event (this tenant's or not) is not part of this
      // one: the same refusal as an unknown id, naming nothing.
      if (openDayIds.some((id) => !liveDayIds.has(id))) {
        throw new HttpError(422, "One of the chosen days isn't part of this event.", CODES.OPEN_DAY_UNKNOWN);
      }
      if (liveDayIds.size > 0 && openDayIds.length === 0) {
        throw new HttpError(422, 'Keep at least one day open to registration.', CODES.NO_OPEN_DAYS);
      }
    }

    await registrationSettingsRepository.update(event.id, userId, write, openDayIds);
    return registrationSettingsService.get(eventId, requestingRole, tenantId);
  },
};
