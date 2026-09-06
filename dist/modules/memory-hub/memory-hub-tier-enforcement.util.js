import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { memoryHubRepository } from './memory-hub.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
// Called before issuing an upload signature (both organiser and guest
// paths) and before viewing/managing a hub in ways that assume the
// tier permits it at all. Spark has no Memory Hub — this is the
// all-or-nothing gate, read at runtime, never hardcoded, so a Super
// Admin toggling memoryHubEnabled takes effect immediately.
export const assertMemoryHubAccessible = async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
    if (!config?.memoryHubEnabled) {
        throw new HttpError(403, `The ${tenant.subscriptionTier} plan does not include Memory Hub. Upgrade to CELEBRATE or ELEVATE to use it.`);
    }
};
// null = unlimited, same convention as every other max* column.
export const getMemoryHubQuotaBytes = async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
    return config?.maxMemoryHubBytesPerEvent ?? null;
};
// ─────────────────────────────────────────
//  QUOTA — summed on demand, never a running counter (see
//  memory-hub.repository.ts's sumBytesForEvent for the query and why).
//
//  Called BEFORE issuing an upload signature — a signature is a grant;
//  issuing one when the event is already at its limit means the file
//  uploads to Cloudinary and is then rejected, wasting the guest's
//  bandwidth and our storage bill for nothing. This can only check
//  "is the event already at/over capacity" — the incoming file's exact
//  size is unknowable until Cloudinary reports it after upload, so the
//  very last upload that tips an event over its limit can still land;
//  memory-hub.service.ts's persist step re-checks with the real byte
//  count and destroys+rejects that one if needed. See the batch report.
// ─────────────────────────────────────────
export const assertMemoryHubQuotaAvailable = async (eventId, tenantId) => {
    const maxBytes = await getMemoryHubQuotaBytes(tenantId);
    if (maxBytes == null)
        return;
    const usedBytes = await memoryHubRepository.sumBytesForEvent(eventId);
    if (usedBytes >= maxBytes) {
        const tenant = await tenantRepository.findById(tenantId);
        throw new HttpError(403, `This event's Memory Hub has reached its ${Math.round(maxBytes / (1024 * 1024))}MB storage limit for the ${tenant?.subscriptionTier ?? 'current'} plan. Remove items or upgrade the plan to add more.`);
    }
};
//# sourceMappingURL=memory-hub-tier-enforcement.util.js.map