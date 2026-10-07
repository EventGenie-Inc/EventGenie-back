import { userRepository } from './user.repository.js';
import { type CreateUserDto, type UpdateUserDto } from './user.types.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  suspendFirebaseAccount,
  reactivateFirebaseAccount,
} from '../../shared/firebase/firebase-account-status.util.js';
import { revokeAllDeviceTokensForUser, REVOKE_REASON } from '../auth/device-token.util.js';
import { resolveTenantScope, isTenantScopeEmptyForList } from '../../shared/utils/tenant-scope.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { normalizeEmail } from '../../shared/utils/email.util.js';
import { isUniqueViolationOn } from '../../shared/utils/prisma-error.util.js';
import { eventAssignmentRepository } from '../event-assignment/event-assignment.repository.js';
import { eventAssignmentLock } from '../event-assignment/event-assignment-lock.util.js';
import { userInviteRepository } from './user-invite.repository.js';
import { type SetAssignmentsDto } from './user.types.js';

// One email, one account, platform-wide. Thrown by POST /api/users and by
// team invitations (create, resend, accept), both from the pre-check and
// from the database's own unique index when two creations race past it.
export const USER_EMAIL_TAKEN_MESSAGE = 'A user with this email address already exists. Use a different email address.';
export const USER_EMAIL_TAKEN = 'USER_EMAIL_TAKEN';

export const userEmailTakenError = (message: string = USER_EMAIL_TAKEN_MESSAGE): HttpError =>
  new HttpError(409, message, USER_EMAIL_TAKEN);

export const VENDOR_ROLE_UNAVAILABLE_MESSAGE = "Vendor accounts aren't available yet. Choose a different role for this user.";

export const LAST_TENANT_ADMIN_DEMOTE_MESSAGE =
  "This is your workspace's only active tenant admin. Make someone else a tenant admin first, then change this person's role.";
export const LAST_TENANT_ADMIN_SUSPEND_MESSAGE =
  "This is your workspace's only active tenant admin. Make someone else a tenant admin first, then suspend this person.";
export const SELF_SUSPEND_MESSAGE = "You can't suspend your own account.";

export const TENANT_ADMIN_ASSIGNMENT_MESSAGE =
  "Tenant admins work on every event, so they can't be assigned to particular ones. Choose the event admin role to assign events.";

// Assignment ids for an invite or a member: an array of strings, each a
// live event of this tenant (another tenant's event, or an archived one, is
// 'Event not found', the cross-tenant 404). allowedExtra: ids the member is
// already assigned to, kept even if that event has since been archived.
export const parseAssignmentEventIds = async (
  tenantId: string,
  raw: unknown,
  allowedExtra: readonly string[] = []
): Promise<string[]> => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new HttpError(400, 'eventIds must be a list of event ids.');
  }
  const ids = [...new Set((raw as string[]).map((id) => id.trim()))];
  const toCheck = ids.filter((id) => !allowedExtra.includes(id));
  if (toCheck.length) {
    const live = await userInviteRepository.findLiveEventsInTenant(tenantId, toCheck);
    if (live.length !== toCheck.length) throw new HttpError(404, 'Event not found');
  }
  return ids;
};


const ROLES_ASSIGNABLE_BY_TENANT_ADMIN: PlatformRole[] = ['TENANT_ADMIN', 'EVENT_ADMIN', 'EVENT_VENDOR'];

// TENANT_ADMIN and EVENT_ADMIN are operationally tenant-scoped everywhere
// (requireTenantAdmin/requireEventAdmin, and now tenant-scope.util.ts's
// resolveTenantScope) — a user with either role and no tenantId is
// exactly the "should never exist" state Security Sweep Before G3's Fix 1
// made getById/getAll fail closed against. SUPER_ADMIN is deliberately
// platform-wide (no tenant of its own); EVENT_VENDOR is deliberately
// scoped by VendorSpaceUser membership, not tenantId (a platform-level
// vendor space has none either — see vendor.service.ts's header comment).
// Neither belongs in this list.
const ROLES_REQUIRING_TENANT: PlatformRole[] = ['TENANT_ADMIN', 'EVENT_ADMIN'];

// Shared by create() and update() — the only two places a role gets
// assigned — so the rule set lives in exactly one place.
interface AssertMayAssignRoleInput {
  requesterRole: PlatformRole;
  requesterId: string;
  newRole: PlatformRole;
  // Omitted when creating a brand-new user: there is no existing target
  // to self-check against or to protect if it's currently SUPER_ADMIN.
  targetId?: string;
  targetCurrentRole?: PlatformRole;
}

const assertMayAssignRole = (input: AssertMayAssignRoleInput): void => {
  const { requesterRole, requesterId, newRole, targetId, targetCurrentRole } = input;

  // Rule: nobody may change their own role, regardless of role — including
  // SUPER_ADMIN. This is the escalation vector that matters most.
  if (targetId !== undefined && requesterId === targetId) {
    throw new HttpError(403, 'You cannot change your own role.');
  }

  // Rule: a SUPER_ADMIN's role may only be changed by another SUPER_ADMIN.
  if (targetCurrentRole === 'SUPER_ADMIN' && requesterRole !== 'SUPER_ADMIN') {
    throw new HttpError(403, "Only a SUPER_ADMIN may change another SUPER_ADMIN's role.");
  }

  if (requesterRole === 'SUPER_ADMIN') return; // may assign any role

  if (requesterRole === 'TENANT_ADMIN') {
    if (!ROLES_ASSIGNABLE_BY_TENANT_ADMIN.includes(newRole)) {
      throw new HttpError(403, `TENANT_ADMIN cannot assign the ${newRole} role.`);
    }
    return;
  }

  // Defense in depth — EVENT_ADMIN/EVENT_VENDOR are already blocked from
  // reaching this router at all by requireTenantAdmin, so this should be
  // unreachable via HTTP, but never fall through to an implicit allow.
  throw new HttpError(403, 'You do not have permission to assign roles.');
};

type AssignmentRow = Awaited<ReturnType<typeof eventAssignmentRepository.findForTenant>>[number];

const toMemberView = <U extends { id: string; isActive: boolean; isArchived: boolean }>(user: U, assignments: AssignmentRow[]) => ({
  ...user,
  status: user.isArchived || !user.isActive ? ('SUSPENDED' as const) : ('ACTIVE' as const),
  assignments: assignments
    .filter((a) => a.userId === user.id)
    .map((a) => ({ eventId: a.event.id, eventName: a.event.name, eventIsArchived: a.event.isArchived })),
});

export const userService = {

  getAll: async (requestingRole: PlatformRole, tenantId: string | null) => {
    // SUPER_ADMIN sees all users, including suspended ones — the Super
    // Admin must always be able to see and restore suspended entities.
    if (requestingRole === 'SUPER_ADMIN') return userRepository.findAll(undefined, true);
    // A non-SUPER_ADMIN with no tenantId should never exist — fail closed
    // with an empty list rather than an unscoped, every-tenant query. See
    // tenant-scope.util.ts.
    if (isTenantScopeEmptyForList(requestingRole, tenantId)) return [];
    return userService.getTeam(tenantId as string);
  },

  // The team list (Team Members batch): every member of the tenant,
  // SUSPENDED ones included — this is where a TENANT_ADMIN reactivates
  // someone, so hiding them (as this list used to) left no way back. Each
  // row is the user as before, plus `status` and `assignments` (an
  // EVENT_ADMIN's assigned events; empty = sees every event; an archived
  // event still counts, see EventAssignment's schema comment).
  getTeam: async (tenantId: string) => {
    const [users, assignments] = await Promise.all([
      userRepository.findAllForTeam(tenantId),
      eventAssignmentRepository.findForTenant(tenantId),
    ]);
    return users.map((user) => toMemberView(user, assignments));
  },

  getMember: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const user = await userService.getById(id, requestingRole, tenantId, true);
    const assignments = user.tenantId ? await eventAssignmentRepository.findForTenant(user.tenantId) : [];
    return toMemberView(user, assignments);
  },

  // PUT /api/users/:id/assignments — replaces the member's whole list.
  // EVENT_ADMIN only (422 otherwise). Removing the LAST assignment widens
  // their access to every event, so it's 409 ASSIGNMENT_LOCK_RELEASE unless
  // confirmWidening is true (event-assignment-lock.util.ts).
  setAssignments: async (id: string, requestingRole: PlatformRole, tenantId: string | null, requesterId: string, data: SetAssignmentsDto) => {
    const member = await userService.getById(id, requestingRole, tenantId, true);
    if (member.role !== 'EVENT_ADMIN' || !member.tenantId) throw new HttpError(422, TENANT_ADMIN_ASSIGNMENT_MESSAGE);
    if (data?.eventIds === undefined) throw new HttpError(400, 'eventIds is required: the full list of events to assign (may be empty).');

    const currentIds = await eventAssignmentRepository.findEventIdsForUser(id);
    const nextIds = await parseAssignmentEventIds(member.tenantId, data.eventIds, currentIds);
    eventAssignmentLock.assertReleaseConfirmed({
      currentIds,
      nextIds,
      confirmWidening: data.confirmWidening,
      memberName: member.username,
    });

    await eventAssignmentRepository.replaceForUser(member.tenantId, id, nextIds, requesterId);
    return userService.getMember(id, requestingRole, tenantId);
  },

  // requestingRole/tenantId scope the lookup to the caller's own tenant;
  // SUPER_ADMIN bypasses, matching the pattern already used by
  // eventService.getById. Thrown as HttpError so cross-tenant access
  // surfaces as 404, not a generic 500.
  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const scope = resolveTenantScope(requestingRole, tenantId, 'User not found');
    const user = await userRepository.findById(id, includeArchived, scope);

    if (!user) throw new HttpError(404, 'User not found');
    return user;
  },

  create: async (requestingRole: PlatformRole, requesterId: string, requesterTenantId: string | null, data: CreateUserDto) => {
    assertMayAssignRole({ requesterRole: requestingRole, requesterId, newRole: data.role });

    // TENANT_ADMIN: tenantId is forced to the requester's own tenant —
    // data.tenantId is never read on this path, not merely overwritten
    // after validation. SUPER_ADMIN: may specify any tenantId (or none,
    // for the SUPER_ADMIN shape).
    const resolvedTenantId = requestingRole === 'SUPER_ADMIN' ? data.tenantId : (requesterTenantId ?? undefined);

    // Valid shape (a real role, a real requester), unsatisfied
    // precondition (that role needs a tenant and none was given) — 422,
    // per STEERING's status table, not 400. A TENANT_ADMIN creating one
    // of these always supplies requesterTenantId (their own), so this
    // fires only for a misconfigured requester or a SUPER_ADMIN who
    // omitted tenantId — exactly the state Fix 1 made getById/getAll
    // fail closed against; this stops it being created in the first place.
    if (ROLES_REQUIRING_TENANT.includes(data.role) && !resolvedTenantId) {
      throw new HttpError(422, `A ${data.role} must belong to a tenant — specify tenantId.`);
    }

    // With the vendors feature off there is nothing for a vendor to sign
    // in to, so the role can't be created. Existing vendor users are left
    // alone (switching a flag off never touches data).
    if (data.role === 'EVENT_VENDOR' && !isFeatureEnabled('vendors')) {
      throw new HttpError(422, VENDOR_ROLE_UNAVAILABLE_MESSAGE);
    }

    // Stored and compared lowercase and trimmed (shared/utils/email.util.ts).
    const email = normalizeEmail(typeof data.email === 'string' ? data.email : '');

    // EVENT_VENDOR users are no longer linked to a space at creation —
    // vendor-space membership is many-to-many now (VendorSpaceUser) and
    // is assigned separately afterward, via vendorService.assignVendorUser.
    const existing = await userRepository.findByEmail(email);
    // 409 with a code, not a bare Error (which the global handler turns into
    // a generic 500): the client marks the email field from the code.
    if (existing) throw userEmailTakenError();

    try {
      return await userRepository.create({
        firebaseUid: data.firebaseUid,
        email,
        username: data.username,
        role: data.role,
        ...(resolvedTenantId !== undefined && { tenantId: resolvedTenantId }),
      });
    } catch (err) {
      // Two creations of one email at the same moment both pass the check
      // above; the unique index stops the second. Same 409, not a 500.
      if (isUniqueViolationOn(err, 'User', 'email')) throw userEmailTakenError();
      throw err;
    }
  },

  // Only username and role are ever written (UpdateUserDto). A role change
  // is checked against every rule in one place, whichever route asked
  // (PUT /api/users/:id, PUT /api/team/members/:id/role):
  // - who may assign which role (assertMayAssignRole);
  // - with vendors off, CHANGING someone to EVENT_VENDOR is 422, like
  //   creating one (re-sending a vendor's own role is not a change);
  // - a tenant always keeps one active TENANT_ADMIN: demoting the last one
  //   is 409, checked under the tenant's team lock (user.repository.ts);
  // - assignments belong to EVENT_ADMIN only, so a change to any other
  //   role clears them in the same transaction (a TENANT_ADMIN is never
  //   locked, and a later demotion must not silently bring old ones back).
  update: async (id: string, requestingRole: PlatformRole, tenantId: string | null, requesterId: string, data: UpdateUserDto) => {
    const target = await userService.getById(id, requestingRole, tenantId);
    const changes: UpdateUserDto = {
      ...(data.username !== undefined && { username: data.username }),
      ...(data.role !== undefined && { role: data.role }),
    };

    const roleChanges = changes.role !== undefined && changes.role !== target.role;
    if (changes.role !== undefined) {
      assertMayAssignRole({
        requesterRole: requestingRole,
        requesterId,
        newRole: changes.role,
        targetId: id,
        targetCurrentRole: target.role,
      });
      if (roleChanges && changes.role === 'EVENT_VENDOR' && !isFeatureEnabled('vendors')) {
        throw new HttpError(422, VENDOR_ROLE_UNAVAILABLE_MESSAGE);
      }
    }

    if (!roleChanges || !target.tenantId) return userRepository.update(id, changes);

    const targetTenantId = target.tenantId;
    return userRepository.withTenantTeamLock(targetTenantId, async (tx) => {
      if (target.role === 'TENANT_ADMIN' && target.isActive && !target.isArchived) {
        const others = await userRepository.countOtherActiveWithRole(tx, targetTenantId, 'TENANT_ADMIN', id);
        if (others === 0) throw new HttpError(409, LAST_TENANT_ADMIN_DEMOTE_MESSAGE);
      }
      if (changes.role !== 'EVENT_ADMIN') await eventAssignmentRepository.deleteAllForUser(tx, id);
      return userRepository.update(id, changes, tx);
    });
  },

  // SUSPEND (the user term; the row is archived). requesterId: nobody can
  // suspend themselves (403), and a tenant always keeps one active
  // TENANT_ADMIN (409, under the tenant's team lock, so two admins
  // suspending each other at once can't both succeed).
  archive: async (id: string, requestingRole: PlatformRole, tenantId: string | null, requesterId: string) => {
    if (id === requesterId) throw new HttpError(403, SELF_SUSPEND_MESSAGE);
    const user = await userService.getById(id, requestingRole, tenantId);
    const archived = user.tenantId
      ? await userRepository.withTenantTeamLock(user.tenantId, async (tx) => {
          if (user.role === 'TENANT_ADMIN' && user.isActive && !user.isArchived) {
            const others = await userRepository.countOtherActiveWithRole(tx, user.tenantId as string, 'TENANT_ADMIN', id);
            if (others === 0) throw new HttpError(409, LAST_TENANT_ADMIN_SUSPEND_MESSAGE);
          }
          return userRepository.archive(id, tx);
        })
      : await userRepository.archive(id);
    await suspendFirebaseAccount(user.firebaseUid);
    // Trusted Devices — exchangeSession's own isActive/isArchived check
    // already blocks a suspended user regardless of device-token state,
    // so this isn't what makes suspension effective immediately. It
    // matters for what happens AFTER: without this, a device trusted
    // before the suspension would silently still be trusted the moment
    // the user is reactivated — no fresh 2FA, no record anything
    // happened in between. Revoking here means reactivation always
    // starts from zero trusted devices.
    await revokeAllDeviceTokensForUser(id, REVOKE_REASON.USER_SUSPENDED);
    return archived;
  },

  reactivate: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find a user that is currently archived and un-archive them.
    const user = await userService.getById(id, requestingRole, tenantId, true);
    const reactivated = await userRepository.reactivate(id);
    await reactivateFirebaseAccount(user.firebaseUid);
    return reactivated;
  },
};