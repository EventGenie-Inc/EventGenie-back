import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { vendorRepository } from './vendor.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
// Called before creating a new vendor space (POST /api/vendors).
//
// tenantId is null for a SUPER_ADMIN-managed, tenant-less vendor space
// (VendorSpace.tenantId is nullable — see the batch report on why that's
// a real, distinct case, not an oversight). There's no tenant plan to
// enforce against a space nobody's tenant owns, so this is a no-op for
// that case; a SUPER_ADMIN's own marketplace curation isn't bound by
// any tenant's subscription.
export const assertVendorSpaceCreatable = async (tenantId) => {
    if (!tenantId)
        return;
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    // vendorMarketplace is an all-or-nothing capability gate (can this
    // tier use the marketplace at all) — read at runtime, never hardcoded,
    // so a Super Admin toggling it takes effect immediately.
    const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
    if (!config?.vendorMarketplace) {
        throw new HttpError(403, `The ${tenant.subscriptionTier} plan does not include the vendor marketplace. Upgrade to CELEBRATE or ELEVATE to add a vendor space.`);
    }
    // maxVendorSpaces is the separate numeric ceiling for tiers that DO
    // have marketplace access — null means unlimited, same convention as
    // maxEvents/maxGuestsPerEvent.
    if (config.maxVendorSpaces != null) {
        const activeCount = await vendorRepository.countActiveSpacesForTenant(tenantId);
        if (activeCount >= config.maxVendorSpaces) {
            throw new HttpError(403, `The ${tenant.subscriptionTier} plan allows a maximum of ${config.maxVendorSpaces} active vendor space(s). Archive an existing space or upgrade your plan to add another.`);
        }
    }
};
// Called before a DISCOVERY search (findNearbyVendors / getNearbyVendorsForEvent).
// This is the OTHER side of vendorMarketplace: not just "can this tenant
// be found as a vendor" but "can this tenant's organisers use the
// marketplace to search for vendors at all". Same boolean, same
// all-or-nothing gate, checked against the SEARCHING tenant rather than
// a target being created.
//
// tenantId null (SUPER_ADMIN) always passes — there's no tenant plan to
// check against, and the platform owner isn't bound by one.
export const assertVendorMarketplaceAccessible = async (tenantId) => {
    if (!tenantId)
        return;
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
    if (!config?.vendorMarketplace) {
        throw new HttpError(403, `The ${tenant.subscriptionTier} plan does not include the vendor marketplace. Upgrade to CELEBRATE or ELEVATE to search for vendors.`);
    }
};
//# sourceMappingURL=vendor-tier-enforcement.util.js.map