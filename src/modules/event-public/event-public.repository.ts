import crypto from 'crypto';
import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;

// Guest-originated writes have no platform userId — Invite.createdBy/
// updatedBy is a plain String (not an FK), same convention as
// rsvp.service.ts's GUEST_ACTOR. The 20261007100000_public_registration
// migration's backfill keys on this exact value, so it must not change.
export const SELF_REGISTRATION_ACTOR = 'guest-self-registration';

export interface RegistrationSeats {
  // Live primary guests on the event (plus-ones excluded): what the plan's
  // maxGuestsPerEvent is compared with (guestRepository.countForEvent).
  primaryGuests: number;
  // What the organiser's registration cap counts: live self-registered
  // guests who haven't declined, plus their live plus-ones.
  registeredSeats: number;
}

export interface CreateRegistrantInput {
  firstName: string;
  surname: string | null;
  email: string;
  phoneNumber: string | null;
  plusOnesAllowed: number;
  // The days the invite offers (every day open to registration), so the
  // guest can change which they attend later, like any guest.
  invitedDayIds: string[];
  // The days they said they'll attend.
  attendingDayIds: string[];
  plusOneNames: string[];
}

const db = (tx?: Tx) => tx ?? prisma;

export const eventPublicRepository = {
  // Serialises registrations for one event: the cap and the duplicate-
  // email check are only true while no other registration for the same
  // event can commit in between. Same row-lock idiom as
  // user.repository.ts's withTenantTeamLock. The timeout allows for the
  // ~8 round trips a registration makes to a remote database.
  withEventRegistrationLock: <T>(eventId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
        return fn(tx);
      },
      { maxWait: 10_000, timeout: 15_000 }
    ),

  // Locks the event row inside a transaction someone else opened — RSVP
  // submit, when a self-registered guest asks for more seats.
  lockEvent: async (tx: Tx, eventId: string): Promise<void> => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  },

  // One round trip for both counts (see RegistrationSeats).
  countSeats: async (eventId: string, tx?: Tx): Promise<RegistrationSeats> => {
    const rows = await db(tx).$queryRaw<{ primaryGuests: bigint; registeredSeats: bigint }[]>`
      SELECT
        (SELECT COUNT(*) FROM "Guest" g
          WHERE g."eventId" = ${eventId} AND g."isArchived" = false AND g."hostGuestId" IS NULL
        ) AS "primaryGuests",
        (SELECT COUNT(*) FROM "Guest" g
          WHERE g."eventId" = ${eventId} AND g."isArchived" = false AND g."hostGuestId" IS NULL
            AND g."selfRegisteredAt" IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "Invite" i
              WHERE i."guestId" = g."id" AND i."isArchived" = false AND i."status" <> 'DECLINED'
            )
        )
        +
        (SELECT COUNT(*) FROM "Guest" p
          JOIN "Guest" h ON h."id" = p."hostGuestId"
          WHERE p."eventId" = ${eventId} AND p."isArchived" = false
            AND h."isArchived" = false AND h."selfRegisteredAt" IS NOT NULL
        ) AS "registeredSeats"`;
    const row = rows[0];
    return { primaryGuests: Number(row?.primaryGuests ?? 0), registeredSeats: Number(row?.registeredSeats ?? 0) };
  },

  // The live guest on this event with this email, compared in normal form
  // on both sides (a row the lowercase_emails migration skipped still
  // matches its other casing). `email` must already be normalised.
  findGuestByEmail: async (eventId: string, email: string, tx?: Tx) => {
    const rows = await db(tx).$queryRaw<{ id: string; selfRegisteredAt: Date | null }[]>`
      SELECT "id", "selfRegisteredAt" FROM "Guest"
      WHERE "eventId" = ${eventId} AND "isArchived" = false
        AND lower(regexp_replace("email", '^\\s+|\\s+$', '', 'g')) = ${email}
      ORDER BY "createdAt" ASC
      LIMIT 1`;
    return rows[0] ?? null;
  },

  // The guest, their accepted invite (with the days it offers and the days
  // they attend), and any plus-ones (each an accepted Guest+Invite pair
  // attending the same days, exactly as rsvp.service.ts's submit() creates
  // them, so check-in and the guest list need nothing new). Batched with
  // pre-generated ids: five writes whatever the party size.
  createRegistrant: async (tx: Tx, eventId: string, data: CreateRegistrantInput, now: Date) => {
    const guestId = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const plusOneGuestIds = data.plusOneNames.map(() => crypto.randomUUID());
    const plusOneInviteIds = data.plusOneNames.map(() => crypto.randomUUID());

    await tx.guest.create({
      data: {
        id: guestId,
        eventId,
        firstName: data.firstName,
        surname: data.surname,
        email: data.email,
        phoneNumber: data.phoneNumber,
        plusOnesAllowed: data.plusOnesAllowed,
        selfRegisteredAt: now,
        isArchived: false,
      },
    });

    if (data.plusOneNames.length > 0) {
      await tx.guest.createMany({
        data: data.plusOneNames.map((name, i) => ({
          id: plusOneGuestIds[i]!,
          eventId,
          firstName: name,
          surname: null,
          email: null,
          phoneNumber: null,
          hostGuestId: guestId,
          plusOnesAllowed: 0,
          isArchived: false,
        })),
      });
    }

    const acceptedInvite = {
      eventId,
      status: 'ACCEPTED' as const,
      used: true,
      usedAt: now,
      deliveryMethod: 'EMAIL' as const,
      expiresAt: null,
      isArchived: false,
      createdBy: SELF_REGISTRATION_ACTOR,
      updatedBy: SELF_REGISTRATION_ACTOR,
    };
    await tx.invite.createMany({
      data: [
        { ...acceptedInvite, id: inviteId, guestId, token },
        ...plusOneInviteIds.map((id, i) => ({
          ...acceptedInvite,
          id,
          guestId: plusOneGuestIds[i]!,
          token: crypto.randomBytes(32).toString('hex'),
        })),
      ],
    });

    await tx.inviteEventDay.createMany({
      data: [
        ...data.invitedDayIds.map((eventDayId) => ({ inviteId, eventDayId })),
        ...plusOneInviteIds.flatMap((id) => data.attendingDayIds.map((eventDayId) => ({ inviteId: id, eventDayId }))),
      ],
    });

    await tx.attendance.createMany({
      data: [inviteId, ...plusOneInviteIds].flatMap((id) =>
        data.attendingDayIds.map((eventDayId) => ({ inviteId: id, eventDayId }))
      ),
    });

    return { guestId, invite: { id: inviteId, token, deliveredAt: null } };
  },

  // A returning registrant's live invite, with what the email names: the
  // days it offers and the days they said they'll attend.
  findLatestInviteForGuest: (guestId: string) =>
    prisma.invite.findFirst({
      where: { guestId, isArchived: false },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        token: true,
        deliveredAt: true,
        inviteEventDay: { where: { eventDay: { isArchived: false } }, select: { eventDay: true } },
        attendances: { where: { eventDay: { isArchived: false } }, select: { eventDay: true } },
      },
    }),
};
