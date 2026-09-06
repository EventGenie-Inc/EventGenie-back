import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
// Called before building/streaming the guest export workbook. Spark has
// no export — this is the all-or-nothing gate, read at runtime, never
// hardcoded, so a Super Admin toggling guestExportEnabled takes effect
// immediately. Same shape as assertMemoryHubAccessible.
export const assertGuestExportEnabled = async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
    if (!config?.guestExportEnabled) {
        throw new HttpError(403, `The ${tenant.subscriptionTier} plan does not include guest list export. Upgrade to CELEBRATE or ELEVATE to use it.`);
    }
};
//# sourceMappingURL=guest-export-tier-enforcement.util.js.map