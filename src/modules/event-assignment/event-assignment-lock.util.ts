import { createAssignmentLock, type AssignmentScope } from '../../shared/utils/assignment-lock.util.js';
import { eventAssignmentRepository } from './event-assignment.repository.js';

// ─────────────────────────────────────────
//  THE EVENT ASSIGNMENT LOCK
//
//  The shared assignment lock (shared/utils/assignment-lock.util.ts) for
//  events: an EVENT_ADMIN with no EventAssignment rows sees every event in
//  their tenant; one with any sees only those. TENANT_ADMIN and SUPER_ADMIN
//  are never locked. EVENT_VENDOR isn't either: vendors reach events only
//  through the read-only GET routes, by tenant, as before.
//
//  Read in exactly one place, eventService's scope resolver
//  (event.service.ts's resolveEventScope), which every event lookup and
//  list goes through, and through it every event sub-resource.
// ─────────────────────────────────────────
export const eventAssignmentLock = createAssignmentLock({
  lockedRoles: ['EVENT_ADMIN'],
  loadAssignedIds: eventAssignmentRepository.findEventIdsForUser,
  noun: 'event',
  logLabel: 'event-assignment-lock',
});

// The Prisma filter an Event `where` adds for a scope, or nothing.
export const eventIdsFilter = (scope: AssignmentScope): string[] | undefined =>
  scope.kind === 'only' ? scope.ids : undefined;
