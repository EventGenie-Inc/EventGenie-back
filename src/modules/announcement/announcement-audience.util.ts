import { type AnnouncementAudience, type InviteStatus } from '@prisma/client';

// ─────────────────────────────────────────
//  WHO AN ANNOUNCEMENT REACHES — decided here and only here
//
//  The candidates are the event's live guests (never archived) who are not
//  plus-ones, each with their latest live invite (never archived). A
//  plus-one is covered by their host, has no contact of their own, and
//  their invite token is never given to anyone, so the button can't be
//  theirs either.
//
//  A candidate is INVITED once their invitation reached them
//  (Invite.deliveredAt) or they registered themselves (selfRegisteredAt):
//  someone still waiting on their invitation, or on a draft event, hasn't
//  heard of the event yet, and an announcement mustn't be how they do.
//  Self-registered guests otherwise count like any other.
//
//  Audiences, on the invite's reply:
//    EVERYONE       accepted or not replied (everyone who hasn't declined)
//    ATTENDING      accepted
//    NOT_REPLIED    not replied
//    NOT_ATTENDING  declined
//
//  Narrowed to one day, each is judged on that day, and only guests
//  invited to it are in any audience:
//    ATTENDING      accepted, and said they'll come that day
//    NOT_REPLIED    not replied
//    NOT_ATTENDING  declined, or accepted without that day
//    EVERYONE       ATTENDING or NOT_REPLIED, for that day
//  So for one day, EVERYONE and NOT_ATTENDING split the guests invited to
//  it between them, just as they split the whole guest list.
// ─────────────────────────────────────────

export const ANNOUNCEMENT_AUDIENCES: readonly AnnouncementAudience[] = ['EVERYONE', 'ATTENDING', 'NOT_REPLIED', 'NOT_ATTENDING'];

export interface AudienceCandidate {
  guestId: string;
  firstName: string | null;
  surname: string | null;
  email: string | null;
  phoneNumber: string | null;
  selfRegisteredAt: Date | null;
  invite: {
    token: string;
    status: InviteStatus;
    deliveredAt: Date | null;
    // Live days only.
    invitedDayIds: string[];
    attendingDayIds: string[];
  };
}

// What announcementRepository.findAudienceGuests returns, per guest.
export interface AudienceGuestRow {
  id: string;
  firstName: string | null;
  surname: string | null;
  email: string | null;
  phoneNumber: string | null;
  selfRegisteredAt: Date | null;
  invites: {
    token: string;
    status: InviteStatus;
    deliveredAt: Date | null;
    inviteEventDay: { eventDayId: string }[];
    attendances: { eventDayId: string }[];
  }[];
}

// One invite per guest: the newest that reached them, else the newest at
// all (which then doesn't count as invited). A guest normally has exactly
// one. A guest with no live invite is no candidate.
export const toAudienceCandidates = (guests: AudienceGuestRow[]): AudienceCandidate[] =>
  guests.flatMap((guest) => {
    const invite = guest.invites.find((i) => guest.selfRegisteredAt || i.deliveredAt) ?? guest.invites[0];
    if (!invite) return [];
    return [{
      guestId: guest.id,
      firstName: guest.firstName,
      surname: guest.surname,
      email: guest.email,
      phoneNumber: guest.phoneNumber,
      selfRegisteredAt: guest.selfRegisteredAt,
      invite: {
        token: invite.token,
        status: invite.status,
        deliveredAt: invite.deliveredAt,
        invitedDayIds: invite.inviteEventDay.map((d) => d.eventDayId),
        attendingDayIds: invite.attendances.map((a) => a.eventDayId),
      },
    }];
  });

export const isInvited = (candidate: AudienceCandidate): boolean =>
  !!candidate.selfRegisteredAt || !!candidate.invite.deliveredAt;

export const isInAudience = (
  invite: AudienceCandidate['invite'],
  audience: AnnouncementAudience,
  dayId: string | null
): boolean => {
  if (dayId === null) {
    switch (audience) {
      case 'EVERYONE':
        return invite.status !== 'DECLINED';
      case 'ATTENDING':
        return invite.status === 'ACCEPTED';
      case 'NOT_REPLIED':
        return invite.status === 'PENDING';
      case 'NOT_ATTENDING':
        return invite.status === 'DECLINED';
    }
  }

  if (!invite.invitedDayIds.includes(dayId)) return false;
  const attendingThatDay = invite.status === 'ACCEPTED' && invite.attendingDayIds.includes(dayId);
  switch (audience) {
    case 'ATTENDING':
      return attendingThatDay;
    case 'NOT_REPLIED':
      return invite.status === 'PENDING';
    case 'EVERYONE':
      return attendingThatDay || invite.status === 'PENDING';
    case 'NOT_ATTENDING':
      return !attendingThatDay && invite.status !== 'PENDING';
  }
};

export interface ReachableGuest {
  guestId: string;
  name: string;
  email: string;
  inviteToken: string;
  selfRegistered: boolean;
}

export interface UnreachableGuest {
  guestId: string;
  name: string;
  phoneNumber: string | null;
}

export interface AudienceSelection {
  reachable: ReachableGuest[];
  // In the audience, but with no email: never silently dropped, always
  // counted and listed to the organiser.
  unreachable: UnreachableGuest[];
}

export const guestName = (guest: { firstName: string | null; surname: string | null }): string =>
  [guest.firstName, guest.surname].filter(Boolean).join(' ').trim() || 'Guest';

export const selectAudience = (
  candidates: AudienceCandidate[],
  audience: AnnouncementAudience,
  dayId: string | null
): AudienceSelection => {
  const reachable: ReachableGuest[] = [];
  const unreachable: UnreachableGuest[] = [];
  for (const candidate of candidates) {
    if (!isInvited(candidate) || !isInAudience(candidate.invite, audience, dayId)) continue;
    const name = guestName(candidate);
    const email = candidate.email?.trim();
    if (email) {
      reachable.push({
        guestId: candidate.guestId,
        name,
        email,
        inviteToken: candidate.invite.token,
        selfRegistered: !!candidate.selfRegisteredAt,
      });
    } else {
      unreachable.push({ guestId: candidate.guestId, name, phoneNumber: candidate.phoneNumber });
    }
  }
  return { reachable, unreachable };
};
