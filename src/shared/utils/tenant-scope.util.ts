import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';

// A non-SUPER_ADMIN caller with no tenantId is a state that should never
// exist — every real tenant-scoped role is created with one (see
// auth.repository.ts's registerTenantAndAdmin, user.service.ts's create).
// The bug this guards against: a repository's `tenantId?: string` param,
// filtered with `...(tenantId ? { tenantId } : {})`, is optional so a
// SUPER_ADMIN can pass undefined and bypass scoping on purpose — but the
// SAME undefined falls out of `tenantId ?? undefined` whenever a
// non-SUPER_ADMIN's tenantId is null, silently widening "only my tenant"
// into "every tenant". Cross-tenant access from exactly this shape has
// been found and fixed in this codebase five separate times (STEERING.md).
// event.service.ts, user.service.ts, guest.service.ts and vendor.service.ts
// all had their own copy of the conversion; these two helpers are the one
// place it happens now, so it cannot drift between modules again.
const logMissingTenant = (requestingRole: PlatformRole, shape: 'lookup' | 'list'): void => {
  console.error(
    `[tenant-scope] non-SUPER_ADMIN caller (role=${requestingRole}) has no tenantId — refusing this ${shape} ` +
      'rather than returning an unscoped result. This state should never exist; check how the user was created.'
  );
};

// FOR A SINGLE RECORD BY ID. SUPER_ADMIN passes undefined to bypass
// scoping — that is the role's purpose. Everyone else must carry a real
// tenantId, or this throws the SAME 404 an actual cross-tenant record
// would get: per STEERING's cross-tenant rule, a caller must never be
// able to tell "record in another tenant" apart from "I have no tenant
// at all" — both look identical from the outside, on purpose.
export const resolveTenantScope = (
  requestingRole: PlatformRole,
  tenantId: string | null,
  notFoundMessage: string
): string | undefined => {
  if (requestingRole === 'SUPER_ADMIN') return undefined;
  if (tenantId) return tenantId;
  logMissingTenant(requestingRole, 'lookup');
  throw new HttpError(404, notFoundMessage);
};

// FOR A LIST. Same invalid state, but there is no single record to 404
// on — an empty list is the fail-closed answer: it leaks nothing, and it
// renders as "nothing here" rather than a surprise error on a screen a
// legitimately tenant-less role (a platform-level EVENT_VENDOR — see
// vendor.service.ts) may still load. Returns true when the caller should
// be given an empty list instead of running any query.
export const isTenantScopeEmptyForList = (requestingRole: PlatformRole, tenantId: string | null): boolean => {
  if (requestingRole === 'SUPER_ADMIN' || tenantId) return false;
  logMissingTenant(requestingRole, 'list');
  return true;
};
