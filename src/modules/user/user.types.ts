import { type PlatformRole } from '@prisma/client';

export interface CreateUserDto {
  firebaseUid: string;
  email: string;
  username: string;
  role: PlatformRole;
  tenantId?: string;
}

// Only these two are ever written by an update (user.repository.ts's
// update). Suspension has its own path (userService.archive/reactivate),
// with its own rules; isActive was removed from here so a PUT can't
// suspend someone around them.
export interface UpdateUserDto {
  username?: string;
  role?: PlatformRole;
}
// ── Team Members batch ──
// Bodies arrive untyped from the client; every field is checked in
// user-invite.service.ts / user.service.ts before use.

// POST /api/users/invites
export interface CreateTeamInviteDto {
  email?: unknown;
  role?: unknown;
  // EVENT_ADMIN only; omitted or empty = every event.
  eventIds?: unknown;
}

// POST /api/team-invites/accept (the Firebase ID token is the Authorization header)
export interface AcceptTeamInviteDto {
  token?: unknown;
  username?: unknown;
}

// PUT /api/users/:id/assignments — the member's whole assignment list.
export interface SetAssignmentsDto {
  eventIds?: unknown;
  // Required (true) to remove a member's LAST assignment, which widens
  // their access to every event (409 ASSIGNMENT_LOCK_RELEASE otherwise).
  confirmWidening?: unknown;
}
