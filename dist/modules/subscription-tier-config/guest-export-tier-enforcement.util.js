import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEffectiveTier } from '../subscription/effective-tier.util.js';
// Called before building/streaming the guest export workbook. Spark has
// no export — this is the all-or-nothing gate, read at runtime, never
// hardcoded, so a Super Admin toggling guestExportEnabled takes effect
// immediately. Same shape as assertMemoryHubAccessible.
//
// ACTION-time, not access-time: exporting is an organiser convenience
// over data that already exists, not something a guest is relying on —
// blocking it once a tenant lapses cannot break a live event (the
// guest list itself remains fully readable via the normal API either
// way; only the .xlsx download is gated).
export const assertGuestExportEnabled = async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const effectiveTier = resolveEffectiveTier(tenant);
    const config = await subscriptionTierConfigRepository.findByTier(effectiveTier);
    if (!config?.guestExportEnabled) {
        throw new HttpError(403, `The ${effectiveTier} plan does not include guest list export. Upgrade to CELEBRATE or ELEVATE to use it.`);
    }
};
//# sourceMappingURL=guest-export-tier-enforcement.util.js.map