import { PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventFinishesAt } from '../event/event-status.util.js';
import { countAttendingForDays } from '../event-day/day-capacity.util.js';
import { resolveEventPlanName } from '../subscription-tier-config/effective-plan.util.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.types.js';
import { adminConsoleRepository, type ConsoleEventRow, type EventFilters } from './admin-console.repository.js';
import {
  CONSOLE_EVENT_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_CHARS,
  type ConsoleEventCounts,
  type ConsoleEventDetail,
  type ConsoleEventListItem,
  type ConsoleEventStatus,
  type ConsoleGuest,
  type ConsoleStats,
  type ConsoleUser,
  type Page,
} from './admin-console.types.js';

// ─────────────────────────────────────────
//  THE SUPER ADMIN CONSOLE (STEERING "Super admin console")
//
//  Read-only, platform-wide: the dashboard's numbers, every user, every
//  event, one event's detail and its guest list. Super admin only (the
//  router gives anyone else the global 404). The internal e-velope
//  organisation and its templates are never in any of them.
//
//  Opening an event's guest list shows guests' personal information, so
//  each view is recorded in the audit log (EVENT_GUEST_LIST_VIEWED: who,
//  which event, when), before the guests are read: a view that can't be
//  recorded isn't shown.
// ─────────────────────────────────────────

type Query = Record<string, unknown>;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const one = (query: Query, key: string): string | undefined => {
  const v = query[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be given once.`);
  return v;
};

const parsePaging = (query: Query): { page: number; pageSize: number; skip: number } => {
  const rawPage = one(query, 'page');
  const rawSize = one(query, 'pageSize');
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const size = rawSize === undefined ? DEFAULT_PAGE_SIZE : Number(rawSize);
  if (!Number.isInteger(page) || page < 1) throw new HttpError(400, 'page must be a whole number of 1 or more.');
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'pageSize must be a whole number of 1 or more.');
  const pageSize = Math.min(size, MAX_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize };
};

// The search's words (blank: none).
const parseSearch = (query: Query): string[] =>
  (one(query, 'search') ?? '').slice(0, MAX_SEARCH_CHARS).trim().split(/\s+/).filter(Boolean);

const parseId = (query: Query, key: string): string | null => {
  const v = one(query, key)?.trim();
  return v ? v : null;
};

const parseDate = (query: Query, key: string): Date | null => {
  const raw = one(query, key)?.trim();
  if (!raw) return null;
  const m = DATE_ONLY.exec(raw);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!d || Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m![3])) throw new HttpError(400, `${key} must be a date (YYYY-MM-DD).`);
  return d;
};

const parseStatus = (query: Query): ConsoleEventStatus | null => {
  const raw = one(query, 'status')?.trim().toUpperCase();
  if (!raw) return null;
  if (!(CONSOLE_EVENT_STATUSES as readonly string[]).includes(raw)) {
    throw new HttpError(400, `status must be one of ${CONSOLE_EVENT_STATUSES.join(', ')}.`);
  }
  return raw as ConsoleEventStatus;
};

const parseRole = (query: Query): PlatformRole | null => {
  const raw = one(query, 'role')?.trim().toUpperCase();
  if (!raw) return null;
  if (!(Object.values(PlatformRole) as string[]).includes(raw)) {
    throw new HttpError(400, `role must be one of ${Object.values(PlatformRole).join(', ')}.`);
  }
  return raw as PlatformRole;
};

// The console's status: ARCHIVED for a deleted event, else its effective
// status (a published event whose last day has ended is FINISHED).
export const consoleStatusOf = (event: Pick<ConsoleEventRow, 'status' | 'isArchived' | 'eventDays'>, now: Date): ConsoleEventStatus => {
  if (event.isArchived) return 'ARCHIVED';
  // resolveEffectiveStatus's rule, judged at `now` (it reads the clock
  // itself), so a response never disagrees with its own filter.
  if (event.status === 'PUBLISHED') {
    const finishesAt = eventFinishesAt(event);
    return finishesAt && finishesAt < now ? 'FINISHED' : 'LIVE';
  }
  return event.status === 'COMPLETED' ? 'FINISHED' : event.status;
};

const toCounts = (c: { byStatus: Partial<Record<string, number>>; checkedIn: number } | undefined): ConsoleEventCounts => {
  const accepted = c?.byStatus['ACCEPTED'] ?? 0;
  const declined = c?.byStatus['DECLINED'] ?? 0;
  const pending = c?.byStatus['PENDING'] ?? 0;
  return { invited: accepted + declined + pending, accepted, declined, checkedIn: c?.checkedIn ?? 0 };
};

const toListFields = (row: ConsoleEventRow, now: Date): Omit<ConsoleEventListItem, 'counts'> => ({
  id: row.id,
  name: row.name,
  status: consoleStatusOf(row, now),
  tenant: { id: row.tenant.id, name: row.tenant.name },
  firstDate: row.eventDays[0]?.date ?? null,
  lastDate: row.eventDays.length ? row.eventDays[row.eventDays.length - 1]!.date : null,
  visibility: row.visibility,
  planName: resolveEventPlanName(row.tenant, row.tenant.customTier?.name ?? null, row, now),
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});

export const adminConsoleService = {
  // GET /api/admin/stats
  stats: async (now: Date = new Date()): Promise<ConsoleStats> => {
    const [tenants, total, draft, live, finished, cancelled, archived, guests] = await Promise.all([
      adminConsoleRepository.countTenants(),
      adminConsoleRepository.countEvents(null, now),
      adminConsoleRepository.countEvents('DRAFT', now),
      adminConsoleRepository.countEvents('LIVE', now),
      adminConsoleRepository.countEvents('FINISHED', now),
      adminConsoleRepository.countEvents('CANCELLED', now),
      adminConsoleRepository.countEvents('ARCHIVED', now),
      adminConsoleRepository.countGuests(),
    ]);
    return {
      tenants: { total: tenants },
      events: { total, draft, live, finished, cancelled, archived },
      guests: { total: guests },
    };
  },

  // GET /api/admin/users?search&tenantId&role&page&pageSize
  listUsers: async (query: Query): Promise<Page<ConsoleUser>> => {
    const { page, pageSize, skip } = parsePaging(query);
    const filters = { terms: parseSearch(query), tenantId: parseId(query, 'tenantId'), role: parseRole(query) };
    const { rows, total } = await adminConsoleRepository.findUsers(filters, skip, pageSize);
    const lastSignIns = await adminConsoleRepository.findLastSignIns(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        email: r.email,
        role: r.role,
        status: r.isArchived ? 'ARCHIVED' : r.isActive ? 'ACTIVE' : 'SUSPENDED',
        tenant: r.tenant,
        createdAt: r.createdAt,
        lastSignInAt: lastSignIns.get(r.id) ?? null,
      })),
      page,
      pageSize,
      total,
    };
  },

  // GET /api/admin/events?search&tenantId&status&from&to&page&pageSize
  listEvents: async (query: Query, now: Date = new Date()): Promise<Page<ConsoleEventListItem>> => {
    const { page, pageSize, skip } = parsePaging(query);
    const filters: EventFilters = {
      terms: parseSearch(query),
      tenantId: parseId(query, 'tenantId'),
      status: parseStatus(query),
      from: parseDate(query, 'from'),
      to: parseDate(query, 'to'),
    };
    if (filters.from && filters.to && filters.from > filters.to) throw new HttpError(400, 'from must be on or before to.');
    const { rows, total } = await adminConsoleRepository.findEvents(filters, now, skip, pageSize);
    const counts = await adminConsoleRepository.countInvites(rows.map((r) => r.id));
    return {
      items: rows.map((row) => ({ ...toListFields(row, now), counts: toCounts(counts.get(row.id)) })),
      page,
      pageSize,
      total,
    };
  },

  // GET /api/admin/events/:eventId — archived events too; a template, or no
  // such event, is 404.
  getEvent: async (eventId: string, now: Date = new Date()): Promise<ConsoleEventDetail> => {
    const row = await adminConsoleRepository.findEvent(eventId);
    if (!row) throw new HttpError(404, 'Event not found');
    const [counts, pendingApproval, attendingByDay] = await Promise.all([
      adminConsoleRepository.countInvites([row.id]),
      adminConsoleRepository.countPendingApproval(row.id),
      // The organiser's own per-day count (the event detail's attendingCount).
      countAttendingForDays(row.eventDays.map((d) => d.id)),
    ]);
    const c = counts.get(row.id);
    return {
      ...toListFields(row, now),
      description: row.description,
      hostName: row.hostName,
      ticketing: row.ticketing,
      coverImageUrl: row.coverImageUrl,
      rsvpDeadline: row.rsvpDeadline,
      capacity: row.capacity,
      updatedAt: row.updatedAt,
      eventGrantId: row.eventGrantId,
      days: row.eventDays.map((d) => ({
        id: d.id,
        label: d.label,
        date: d.date,
        startTime: d.startTime,
        endTime: d.endTime,
        locationType: d.locationType,
        location: d.location,
        address: d.address,
        onlineUrl: d.onlineUrl,
        capacity: d.capacity,
        attendingCount: attendingByDay.get(d.id) ?? 0,
      })),
      stats: { ...toCounts(c), pending: c?.byStatus['PENDING'] ?? 0, pendingApproval },
    };
  },

  // GET /api/admin/events/:eventId/guests?search&page&pageSize — recorded
  // in the audit log (one entry per view) before any guest is read.
  listGuests: async (eventId: string, query: Query, actorUserId: string): Promise<Page<ConsoleGuest>> => {
    const { page, pageSize, skip } = parsePaging(query);
    const terms = parseSearch(query);
    const event = await adminConsoleRepository.findEvent(eventId);
    if (!event) throw new HttpError(404, 'Event not found');

    await adminAuditService.record({
      actorUserId,
      tenantId: event.tenantId,
      action: ADMIN_AUDIT_ACTIONS.EVENT_GUEST_LIST_VIEWED,
      // Whether a search was made, never its words (they may be a guest's
      // name or address).
      details: { eventId: event.id, eventName: event.name, page, pageSize, searched: terms.length > 0 },
    });

    const { rows, total } = await adminConsoleRepository.findGuests(eventId, terms, skip, pageSize);
    return {
      items: rows.map((g) => {
        const invite = g.invites[0] ?? null;
        const checkIns = invite?.checkIns ?? [];
        return {
          id: g.id,
          firstName: g.firstName,
          surname: g.surname,
          email: g.email,
          phoneNumber: g.phoneNumber,
          hostGuestId: g.hostGuestId,
          pendingApproval: g.pendingApproval,
          rsvpStatus: invite?.status ?? null,
          checkedIn: checkIns.length > 0,
          checkIns,
          createdAt: g.createdAt,
        };
      }),
      page,
      pageSize,
      total,
    };
  },
};
