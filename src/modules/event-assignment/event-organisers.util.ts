import { type PlatformRole } from '@prisma/client';
import { eventAssignmentRepository } from './event-assignment.repository.js';

// ─────────────────────────────────────────
//  AN EVENT'S ORGANISERS — who an account email about an event goes to
//
//  Whoever created the event and the members assigned to it, active and
//  still able to open it (the assignment lock); when none is, the tenant's
//  active TENANT_ADMINs. Shared by the feedback request
//  (feedback-request.service.ts) and the archived-media reminder
//  (media-retention.service.ts). A query selects the event's people with
//  EVENT_ORGANISERS_SELECT.
// ─────────────────────────────────────────

const ORGANISER_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  role: true,
  tenantId: true,
  isActive: true,
  isArchived: true,
} as const;

export const EVENT_ORGANISERS_SELECT = {
  tenantId: true,
  assignments: { select: { user: { select: ORGANISER_USER_SELECT } } },
  createdByUser: { select: ORGANISER_USER_SELECT },
} as const;

interface OrganiserUser {
  id: string;
  email: string;
  role: PlatformRole;
  tenantId: string | null;
  isActive: boolean;
  isArchived: boolean;
}

export interface EventOrganisersSource {
  tenantId: string;
  assignments: { user: OrganiserUser }[];
  createdByUser: OrganiserUser;
}

export interface EventOrganiser {
  id: string;
  email: string;
}

const ORGANISER_ROLES: PlatformRole[] = ['TENANT_ADMIN', 'EVENT_ADMIN'];

export const resolveEventOrganisers = async (event: EventOrganisersSource): Promise<EventOrganiser[]> => {
  const usable = (user: OrganiserUser): boolean =>
    user.isActive && !user.isArchived && user.tenantId === event.tenantId && ORGANISER_ROLES.includes(user.role);

  const assigned = event.assignments.map((a) => a.user).filter(usable);
  const recipients = new Map<string, EventOrganiser>(assigned.map((u) => [u.id, { id: u.id, email: u.email }]));

  const creator = event.createdByUser;
  if (usable(creator) && !recipients.has(creator.id)) {
    // A locked EVENT_ADMIN who isn't assigned to this event can't open it,
    // so isn't asked.
    const canOpen = creator.role === 'TENANT_ADMIN' || (await eventAssignmentRepository.countForUser(creator.id)) === 0;
    if (canOpen) recipients.set(creator.id, { id: creator.id, email: creator.email });
  }

  if (recipients.size > 0) return [...recipients.values()];
  const admins = await eventAssignmentRepository.findActiveTenantAdmins(event.tenantId);
  return admins.map((u) => ({ id: u.id, email: u.email }));
};
