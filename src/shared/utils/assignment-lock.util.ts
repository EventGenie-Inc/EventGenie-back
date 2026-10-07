import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';
import { getRequestViewer } from '../context/request-viewer.context.js';

// ─────────────────────────────────────────
//  THE ASSIGNMENT LOCK — one rule for any "resource with assignments"
//
//  For a locked role, a user with NO assignments of a kind sees EVERY
//  resource of that kind in their tenant; a user with ANY assignments sees
//  ONLY those. Anything else is a 404, exactly like another tenant's
//  record. Roles not in lockedRoles are never locked.
//
//  Events use it today (event-assignment-lock.util.ts: EVENT_ADMIN,
//  EventAssignment). Vendor spaces are meant to use the same rule later
//  (EVENT_VENDOR, VendorSpaceUser) via another createAssignmentLock call;
//  they are not switched over yet (vendors are off for the pilot), and
//  still enforce membership only (vendor.service.ts's getSpaceForViewer).
//
//  The tenant boundary is not this helper's job: it runs AFTER
//  resolveTenantScope (tenant-scope.util.ts) has already confined the
//  caller to their tenant, and only ever narrows that further.
//
//  "Releasing" the lock — removing a user's LAST assignment — widens their
//  access from a few resources to all of them. assertReleaseConfirmed
//  refuses that unless the request says so explicitly.
// ─────────────────────────────────────────

// 'all': no restriction beyond the tenant. 'only': these ids and no others
// (never empty — an empty assignment list means 'all').
export type AssignmentScope = { kind: 'all' } | { kind: 'only'; ids: string[] };

export const ASSIGNMENT_LOCK_RELEASE = 'ASSIGNMENT_LOCK_RELEASE';

export interface AssignmentLockConfig {
  // The roles this lock applies to. Every other role is 'all'.
  lockedRoles: readonly PlatformRole[];
  // Every assigned resource id for this user — archived resources
  // included, so archiving a user's last assigned resource doesn't quietly
  // widen what they see.
  loadAssignedIds: (userId: string) => Promise<string[]>;
  // The resource, singular, lowercase: "event", "vendor space".
  noun: string;
  // Logged when a locked role has no viewer to read (fail closed).
  logLabel: string;
}

export const scopeFromAssignedIds = (assignedIds: readonly string[]): AssignmentScope =>
  assignedIds.length ? { kind: 'only', ids: [...new Set(assignedIds)] } : { kind: 'all' };

export const isInAssignmentScope = (scope: AssignmentScope, id: string): boolean =>
  scope.kind === 'all' || scope.ids.includes(id);

export const createAssignmentLock = (config: AssignmentLockConfig) => {
  const isLockedRole = (role: PlatformRole): boolean => config.lockedRoles.includes(role);

  return {
    isLockedRole,

    // The scope of the user signed in to THIS request (request-viewer.context.ts),
    // for a call made with requestingRole. A role the lock doesn't cover is
    // 'all' with no query. A locked role with no viewer, or a viewer whose
    // role isn't the one the caller claims, fails closed: 'only' with an
    // impossible id, so a lookup 404s and a list is empty.
    resolveForRequest: async (requestingRole: PlatformRole): Promise<AssignmentScope> => {
      if (!isLockedRole(requestingRole)) return { kind: 'all' };
      const viewer = getRequestViewer();
      if (!viewer || viewer.role !== requestingRole) {
        console.error(
          `[${config.logLabel}] locked role ${requestingRole} with ${viewer ? `a ${viewer.role} viewer` : 'no request viewer'} — ` +
            'refusing rather than guessing whose assignments apply. Code run outside a request, or a callback that ' +
            'lost the request context (wrap it with bindRequestViewer).'
        );
        return { kind: 'only', ids: ['__no_viewer__'] };
      }
      return scopeFromAssignedIds(await config.loadAssignedIds(viewer.userId));
    },

    // For a user given explicitly (team management, auto-assign on create),
    // not the request's viewer.
    resolveForUser: async (userId: string, role: PlatformRole): Promise<AssignmentScope> =>
      isLockedRole(role) ? scopeFromAssignedIds(await config.loadAssignedIds(userId)) : { kind: 'all' },

    // 409 ASSIGNMENT_LOCK_RELEASE when going from some assignments to none
    // without confirmWidening: true. Every other change (adding, swapping,
    // removing all but one, or a list that was already empty) passes.
    assertReleaseConfirmed: (input: {
      currentIds: readonly string[];
      nextIds: readonly string[];
      confirmWidening: unknown;
      memberName: string;
    }): void => {
      if (input.currentIds.length === 0 || input.nextIds.length > 0) return;
      if (input.confirmWidening === true) return;
      throw new HttpError(
        409,
        `Removing ${input.memberName}'s last assignment gives them access to every ${config.noun} ` +
          `in your workspace, not just the ones assigned to them. Confirm to continue.`,
        ASSIGNMENT_LOCK_RELEASE
      );
    },
  };
};

export type AssignmentLock = ReturnType<typeof createAssignmentLock>;
