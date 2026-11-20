import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  THE INTERNAL E-VELOPE ORGANISATION (Tenant.isInternal; STEERING "Custom
//  tiers") holds event templates and nothing a tenant could see. Its
//  templates stay invisible because no tenant's user is in it, and nothing
//  of its own is cross-tenant: so a super admin can't add a user to it, or
//  give it a vendor space (vendor discovery shows every tenant's spaces).
// ─────────────────────────────────────────

export const TENANT_INTERNAL = 'TENANT_INTERNAL';

export const assertNotInternalTenant = async (tenantId: string | null | undefined): Promise<void> => {
  if (!tenantId) return;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isInternal: true } });
  if (tenant?.isInternal) {
    throw new HttpError(422, "The e-velope organisation holds event templates only: it can't have users or vendor spaces.", TENANT_INTERNAL);
  }
};

// Is this the internal organisation? Its events are templates, which need no
// host name (STEERING "Host name"): a granted copy takes the receiving
// organisation's name instead.
export const isInternalTenant = async (tenantId: string): Promise<boolean> => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isInternal: true } });
  return tenant?.isInternal === true;
};
