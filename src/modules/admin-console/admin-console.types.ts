import { type EventTicketing, type EventVisibility, type InviteStatus, type PlatformRole } from '@prisma/client';

// ─────────────────────────────────────────
//  THE SUPER ADMIN CONSOLE (STEERING "Super admin console")
//
//  Read-only, platform-wide views for the super admin: the dashboard's
//  numbers, every user, every event, and one event's detail and guest list.
//  The internal e-velope organisation (its templates) is never in them.
// ─────────────────────────────────────────

// An event as the console shows it: its effective status (a published event
// whose last day has ended is FINISHED), and ARCHIVED for a deleted one,
// whatever it was before.
export const CONSOLE_EVENT_STATUSES = ['DRAFT', 'LIVE', 'FINISHED', 'CANCELLED', 'ARCHIVED'] as const;
export type ConsoleEventStatus = (typeof CONSOLE_EVENT_STATUSES)[number];

export type ConsoleUserStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  // Every match, across all pages.
  total: number;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
// A search is cut to this many characters.
export const MAX_SEARCH_CHARS = 200;

// GET /api/admin/stats
export interface ConsoleStats {
  tenants: { total: number };
  events: { total: number; draft: number; live: number; finished: number; cancelled: number; archived: number };
  guests: { total: number };
}

// GET /api/admin/users
export interface ConsoleUser {
  id: string;
  username: string;
  email: string;
  role: PlatformRole;
  status: ConsoleUserStatus;
  // null for a super admin (no organisation).
  tenant: { id: string; name: string } | null;
  createdAt: Date;
  // The last time they signed in: a sign-in code entered, or a trusted
  // device starting a session. null when never.
  lastSignInAt: Date | null;
}

// Invitation counts, in invitations (a plus-one is one), live guests only,
// registrations awaiting approval left out (they aren't invited yet).
export interface ConsoleEventCounts {
  invited: number;
  accepted: number;
  declined: number;
  // Checked in on at least one day.
  checkedIn: number;
}

// GET /api/admin/events
export interface ConsoleEventListItem {
  id: string;
  name: string;
  status: ConsoleEventStatus;
  tenant: { id: string; name: string };
  // The first and last live day's date (YYYY-MM-DD at UTC midnight); null
  // with no days.
  firstDate: Date | null;
  lastDate: Date | null;
  visibility: EventVisibility;
  // resolveEventPlan's name: a standard tier's ('CELEBRATE') or a custom
  // tier's own. Display only.
  planName: string;
  createdAt: Date;
  archivedAt: Date | null;
  counts: ConsoleEventCounts;
}

export interface ConsoleEventDay {
  id: string;
  label: string;
  date: Date;
  startTime: Date | null;
  endTime: Date | null;
  locationType: string | null;
  location: string | null;
  address: string | null;
  onlineUrl: string | null;
}

// GET /api/admin/events/:eventId
export interface ConsoleEventDetail extends Omit<ConsoleEventListItem, 'counts'> {
  description: string | null;
  hostName: string | null;
  ticketing: EventTicketing;
  coverImageUrl: string | null;
  rsvpDeadline: Date | null;
  capacity: number | null;
  updatedAt: Date;
  eventGrantId: string | null;
  days: ConsoleEventDay[];
  stats: ConsoleEventCounts & {
    // Invited, not yet answered.
    pending: number;
    // Registrations awaiting the organiser's approval (registrants).
    pendingApproval: number;
  };
}

// GET /api/admin/events/:eventId/guests
export interface ConsoleGuest {
  id: string;
  firstName: string | null;
  surname: string | null;
  email: string | null;
  phoneNumber: string | null;
  // A plus-one's host guest; null for anyone else.
  hostGuestId: string | null;
  pendingApproval: boolean;
  // Their live invitation's answer; null without one (awaiting approval).
  rsvpStatus: InviteStatus | null;
  checkedIn: boolean;
  checkIns: { eventDayId: string; checkedInAt: Date }[];
  createdAt: Date;
}
