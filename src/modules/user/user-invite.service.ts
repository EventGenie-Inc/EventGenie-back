import { getAuth } from 'firebase-admin/auth';
import { type PlatformRole } from '@prisma/client';
import { firebaseAdmin } from '../../shared/firebase/firebase.admin.js';
import { verifyOr401 } from '../../shared/firebase/firebase-token-error.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { sendEmail } from '../../shared/messaging/email.engine.js';
import { normalizeEmail, isValidEmail } from '../../shared/utils/email.util.js';
import { isUniqueViolationOn } from '../../shared/utils/prisma-error.util.js';
import { generateSecureToken } from '../../shared/utils/token.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { hashToken } from '../auth/device-token.util.js';
import { userInviteRepository } from './user-invite.repository.js';
import { userRepository } from './user.repository.js';
import {
  userEmailTakenError,
  VENDOR_ROLE_UNAVAILABLE_MESSAGE,
  TENANT_ADMIN_ASSIGNMENT_MESSAGE,
  parseAssignmentEventIds,
} from './user.service.js';
import { buildTeamInviteEmail, TEAM_INVITE_TTL_DAYS } from './user-invite-email.util.js';
import { type CreateTeamInviteDto, type AcceptTeamInviteDto } from './user.types.js';

// ─────────────────────────────────────────
//  TEAM INVITATIONS
//
//  A TENANT_ADMIN invites an email address with a role and, for an
//  EVENT_ADMIN, optional event assignments. The invitee opens
//  <FRONTEND_BASE_URL>/join?token=…, the frontend creates their Firebase
//  account for the invited email and calls POST /api/team-invites/accept;
//  the User is created here, in the inviting tenant. The usual device code
//  step follows on their first sign-in (nothing here issues a session).
//
//  The token: 256 random bits, sent once in the email, stored only as its
//  SHA-256 hash (like DeviceToken), never logged, valid 7 days, single use.
//  Resending mints a new one; the old link stops working.
//
//  Codes (STEERING "Machine-readable codes"), each where the client needs
//  to tell two same-status failures apart:
//  - create/resend: 409 USER_EMAIL_TAKEN (has an account) vs
//    409 TEAM_INVITE_PENDING (already invited: resend instead).
//  - lookup/accept: 404 TEAM_INVITE_INVALID (unknown, revoked, or the
//    workspace is suspended: told apart from a route 404, e.g. the
//    feature switched off), 422 TEAM_INVITE_EXPIRED (vs a 422 for a blank
//    name), 409 TEAM_INVITE_USED vs 409 USER_EMAIL_TAKEN.
// ─────────────────────────────────────────

export const TEAM_INVITE_CODES = {
  PENDING: 'TEAM_INVITE_PENDING',
  INVALID: 'TEAM_INVITE_INVALID',
  EXPIRED: 'TEAM_INVITE_EXPIRED',
  USED: 'TEAM_INVITE_USED',
} as const;

const TEAM_INVITE_TTL_MS = TEAM_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
const INVITABLE_ROLES: PlatformRole[] = ['TENANT_ADMIN', 'EVENT_ADMIN'];
const USERNAME_MAX_LENGTH = 100;

export const ACCEPT_EMAIL_HAS_ACCOUNT_MESSAGE =
  'This email address already has an e-velope account, and an account belongs to one workspace. ' +
  'Sign in with it instead, or ask to be invited with a different email address.';

const invalidInvite = () =>
  new HttpError(404, "This invitation link isn't valid. Ask the person who invited you to send a new one.", TEAM_INVITE_CODES.INVALID);
const expiredInvite = () =>
  new HttpError(422, 'This invitation has expired. Ask the person who invited you to send it again.', TEAM_INVITE_CODES.EXPIRED);
const usedInvite = () =>
  new HttpError(409, 'This invitation has already been accepted. Sign in to continue.', TEAM_INVITE_CODES.USED);

export const roleLabel = (role: PlatformRole): string => (role === 'TENANT_ADMIN' ? 'a tenant admin' : 'an event admin');

type InviteRow = NonNullable<Awaited<ReturnType<typeof userInviteRepository.findById>>>;

// What an admin sees of an invite. Never the token or its hash.
const toInviteView = (invite: InviteRow, eventNames: Map<string, string>) => ({
  id: invite.id,
  email: invite.email,
  role: invite.role,
  status: invite.acceptedAt
    ? ('ACCEPTED' as const)
    : invite.revokedAt
      ? ('REVOKED' as const)
      : invite.expiresAt.getTime() <= Date.now()
        ? ('EXPIRED' as const)
        : ('PENDING' as const),
  assignments: invite.eventIds.map((eventId) => ({ eventId, eventName: eventNames.get(eventId) ?? null })),
  expiresAt: invite.expiresAt,
  lastSentAt: invite.lastSentAt,
  createdAt: invite.createdAt,
  invitedBy: { id: invite.invitedBy.id, name: invite.invitedBy.username },
});

const eventNamesFor = async (tenantId: string, ids: string[]): Promise<Map<string, string>> =>
  ids.length
    ? new Map((await userInviteRepository.findLiveEventsInTenant(tenantId, [...new Set(ids)])).map((e) => [e.id, e.name]))
    : new Map();

const requireTenant = (tenantId: string | null): string => {
  if (!tenantId) throw new HttpError(404, 'Invitation not found');
  return tenantId;
};

const parseRole = (role: unknown): PlatformRole => {
  if (role === 'EVENT_VENDOR') {
    throw new HttpError(
      422,
      isFeatureEnabled('vendors') ? 'Vendors join through their vendor space, not as team members.' : VENDOR_ROLE_UNAVAILABLE_MESSAGE
    );
  }
  if (typeof role !== 'string' || !INVITABLE_ROLES.includes(role as PlatformRole)) {
    throw new HttpError(400, "Choose a role for this person: 'TENANT_ADMIN' or 'EVENT_ADMIN'.");
  }
  return role as PlatformRole;
};

const sendInviteEmail = async (input: {
  email: string;
  tenantId: string;
  inviterId: string;
  role: PlatformRole;
  rawToken: string;
}): Promise<boolean> => {
  const [tenant, inviter] = await Promise.all([
    userInviteRepository.findTenantName(input.tenantId),
    userRepository.findById(input.inviterId, true),
  ]);
  const sent = await sendEmail(
    buildTeamInviteEmail({
      to: input.email,
      companyName: tenant?.name ?? 'your team',
      inviterName: inviter?.username ?? null,
      roleLabel: roleLabel(input.role),
      rawToken: input.rawToken,
    })
  );
  // The reason only, never the email itself: its link carries the token.
  if (!sent.ok) console.error('Failed to send team invitation email:', sent.reason);
  return sent.ok;
};

const mintToken = () => {
  const rawToken = generateSecureToken();
  return { rawToken, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + TEAM_INVITE_TTL_MS) };
};

// The checks every public lookup/accept runs on a token, in order.
const loadInviteForToken = async (rawToken: unknown) => {
  if (typeof rawToken !== 'string' || !rawToken.trim()) throw new HttpError(400, 'token is required');
  const invite = await userInviteRepository.findByTokenHash(hashToken(rawToken.trim()));
  if (!invite || invite.revokedAt || invite.tenant.isArchived) throw invalidInvite();
  if (invite.acceptedAt) throw usedInvite();
  if (invite.expiresAt.getTime() <= Date.now()) throw expiredInvite();
  return invite;
};

export const userInviteService = {

  list: async (tenantId: string | null) => {
    const scopedTenantId = requireTenant(tenantId);
    const invites = await userInviteRepository.findOpenForTenant(scopedTenantId);
    const names = await eventNamesFor(scopedTenantId, invites.flatMap((i) => i.eventIds));
    return invites.map((invite) => toInviteView(invite, names));
  },

  create: async (tenantId: string | null, inviterId: string, data: CreateTeamInviteDto) => {
    const scopedTenantId = requireTenant(tenantId);
    const email = normalizeEmail(typeof data?.email === 'string' ? data.email : '');
    if (!isValidEmail(email)) throw new HttpError(400, 'Enter an email address like name@example.com.');
    const role = parseRole(data.role);
    const eventIds = await parseAssignmentEventIds(scopedTenantId, data.eventIds);
    if (role !== 'EVENT_ADMIN' && eventIds.length) {
      throw new HttpError(422, TENANT_ADMIN_ASSIGNMENT_MESSAGE);
    }

    if (await userRepository.findByEmail(email)) throw userEmailTakenError();
    if (await userInviteRepository.findOpenForTenantAndEmail(scopedTenantId, email)) {
      throw new HttpError(409, 'This email address has already been invited. Resend that invitation instead.', TEAM_INVITE_CODES.PENDING);
    }

    const { rawToken, tokenHash, expiresAt } = mintToken();
    let invite;
    try {
      invite = await userInviteRepository.create({ tenantId: scopedTenantId, email, role, eventIds, tokenHash, expiresAt, invitedByUserId: inviterId });
    } catch (err) {
      // Two invites to one address at once: the partial unique index (see
      // the team_members migration) stops the second.
      if (isUniqueViolationOn(err, 'TeamInvite', 'open_tenant_email')) {
        throw new HttpError(409, 'This email address has already been invited. Resend that invitation instead.', TEAM_INVITE_CODES.PENDING);
      }
      throw err;
    }

    const emailSent = await sendInviteEmail({ email, tenantId: scopedTenantId, inviterId, role, rawToken });
    return { invite: toInviteView(invite, await eventNamesFor(scopedTenantId, eventIds)), emailSent };
  },

  resend: async (tenantId: string | null, inviterId: string, inviteId: string) => {
    const scopedTenantId = requireTenant(tenantId);
    const invite = await userInviteRepository.findById(inviteId, scopedTenantId);
    if (!invite) throw new HttpError(404, 'Invitation not found');
    if (invite.acceptedAt) throw new HttpError(409, 'This invitation has already been accepted.');
    if (invite.revokedAt) throw new HttpError(409, 'This invitation was revoked. Send a new invitation instead.');
    if (await userRepository.findByEmail(invite.email)) throw userEmailTakenError();

    const { rawToken, tokenHash, expiresAt } = mintToken();
    if (!(await userInviteRepository.rotateToken(invite.id, tokenHash, expiresAt))) {
      throw new HttpError(409, 'This invitation was accepted or revoked a moment ago.');
    }
    const emailSent = await sendInviteEmail({ email: invite.email, tenantId: scopedTenantId, inviterId, role: invite.role, rawToken });
    const updated = await userInviteRepository.findById(invite.id, scopedTenantId);
    return { invite: toInviteView(updated as InviteRow, await eventNamesFor(scopedTenantId, invite.eventIds)), emailSent };
  },

  // Idempotent for an already revoked invite; an accepted one is a member
  // now (suspend them instead).
  revoke: async (tenantId: string | null, inviteId: string) => {
    const scopedTenantId = requireTenant(tenantId);
    const invite = await userInviteRepository.findById(inviteId, scopedTenantId);
    if (!invite) throw new HttpError(404, 'Invitation not found');
    if (invite.acceptedAt) {
      throw new HttpError(409, 'This invitation has already been accepted. Suspend the team member instead.');
    }
    const revoked = invite.revokedAt ? invite : await userInviteRepository.revoke(invite.id);
    return toInviteView(revoked, await eventNamesFor(scopedTenantId, invite.eventIds));
  },

  // PUBLIC (token only): what the /join page shows before the account is
  // created, so it can lock the email field. An explicit projection.
  lookup: async (rawToken: unknown) => {
    const invite = await loadInviteForToken(rawToken);
    return {
      email: invite.email,
      companyName: invite.tenant.name,
      role: invite.role,
      expiresAt: invite.expiresAt,
    };
  },

  // PUBLIC (token + Firebase ID token for the new account).
  accept: async (firebaseToken: string, data: AcceptTeamInviteDto) => {
    // A rejected token is a 401; Firebase itself failing stays a 500.
    const decoded = await verifyOr401(
      () => getAuth(firebaseAdmin).verifyIdToken(firebaseToken),
      'Firebase token is invalid or has expired'
    );

    const username = typeof data?.username === 'string' ? data.username.trim() : '';
    if (!username) throw new HttpError(422, 'Enter your name.');
    if (username.length > USERNAME_MAX_LENGTH) throw new HttpError(422, `Keep your name under ${USERNAME_MAX_LENGTH} characters.`);

    const invite = await loadInviteForToken(data?.token);

    const firebaseEmail = normalizeEmail(decoded.email ?? '');
    if (firebaseEmail !== invite.email) {
      throw new HttpError(403, `This invitation is for ${invite.email}. Sign in with that email address to accept it.`);
    }

    // Users belong to one tenant: an address (or Firebase account) that
    // already has a user can't join a second workspace.
    if ((await userRepository.findByEmail(invite.email)) || (await userRepository.findByFirebaseUid(decoded.uid))) {
      throw userEmailTakenError(ACCEPT_EMAIL_HAS_ACCOUNT_MESSAGE);
    }

    // Only events still live in the tenant: one archived since the invite
    // was sent is dropped rather than refusing the whole acceptance.
    const liveEventIds = invite.role === 'EVENT_ADMIN' && invite.eventIds.length
      ? (await userInviteRepository.findLiveEventsInTenant(invite.tenantId, invite.eventIds)).map((e) => e.id)
      : [];
    if (invite.role === 'EVENT_ADMIN' && invite.eventIds.length && !liveEventIds.length) {
      // Every assigned event is gone. Accepting with none would make them an
      // UNLOCKED member who sees every event, which nobody chose.
      throw new HttpError(422, "The events this invitation was for are no longer available. Ask the person who invited you to send a new one.");
    }

    let user;
    try {
      user = await userInviteRepository.accept({
        inviteId: invite.id,
        tenantId: invite.tenantId,
        firebaseUid: decoded.uid,
        email: invite.email,
        username,
        role: invite.role,
        eventIds: liveEventIds,
        invitedByUserId: invite.invitedByUserId,
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'User', 'email') || isUniqueViolationOn(err, 'User', 'firebaseUid')) {
        throw userEmailTakenError(ACCEPT_EMAIL_HAS_ACCOUNT_MESSAGE);
      }
      throw err;
    }
    // Claimed by a simultaneous accept (or expired/revoked a moment ago).
    if (!user) throw usedInvite();

    return {
      user: { id: user.id, email: user.email, username: user.username, role: user.role, tenantId: user.tenantId },
      tenant: { id: invite.tenant.id, name: invite.tenant.name },
    };
  },
};
