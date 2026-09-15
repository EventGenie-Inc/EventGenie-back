import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { memoryHubRepository } from './memory-hub.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEffectiveTier } from '../subscription/effective-tier.util.js';
// Called before issuing an upload signature (organiser AND guest paths)
// and before viewing/managing a hub in ways that assume the tier
// permits it at all. Spark has no Memory Hub — this is the
// all-or-nothing gate, read at runtime, never hardcoded, so a Super
// Admin toggling memoryHubEnabled takes effect immediately.
//
// Subscription Billing batch audit: considered, and deliberately did
// NOT exempt, the guest upload path (memory-hub.service.ts's
// requestGuestUploadSignature) the way ticket purchases were exempted
// for an already-published paid event. The two look similar but
// aren't: every Event gets a MemoryHub row unconditionally at creation
// regardless of tier (event.repository.ts's create()), so a SPARK
// tenant who NEVER had Memory Hub access still has a hub row sitting
// there. There is no stored fact distinguishing "this hub was actually
// enabled and used while paying, then lapsed" from "this tenant never
// had access at all" — TicketPurchase has no such ambiguity, since a
// PAID event can only exist if it passed this exact gate at creation
// or publish time. Bypassing this check for guests would therefore
// hand SPARK tenants who never paid for Memory Hub a working guest
// upload flow, which is a different and wrong outcome, not a
// conservative one. Left gated on effective tier like every other
// capability check; flagged here rather than fixed, since a correct
// fix needs a new "was this feature genuinely provisioned" fact on the
// hub itself, which is a schema decision beyond this ticket.
export const assertMemoryHubAccessible = async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const effectiveTier = resolveEffectiveTier(tenant);
    const config = await subscriptionTierConfigRepository.findByTier(effectiveTier);
    if (!config?.memoryHubEnabled) {
        throw new HttpError(403, `The ${effectiveTier} plan does not include Memory Hub. Upgrade to CELEBRATE or ELEVATE to use it.`);
    }
};
// null = unlimited, same convention as every other max* column. Used
// for the BYTE QUOTA, which — unlike assertMemoryHubAccessible above —
// still applies on the guest path: it bounds EventGenie's own ongoing
// storage cost, not a capability switch, so it stays in effect
// regardless of billing state (falling back to whatever the tenant's
// current effective tier's config says, same as everywhere else).
export const getMemoryHubQuotaBytes = async (tenantId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const config = await subscriptionTierConfigRepository.findByTier(resolveEffectiveTier(tenant));
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
        const effectiveTier = tenant ? resolveEffectiveTier(tenant) : 'current';
        throw new HttpError(403, `This event's Memory Hub has reached its ${Math.round(maxBytes / (1024 * 1024))}MB storage limit for the ${effectiveTier} plan. Remove items or upgrade the plan to add more.`);
    }
};
//# sourceMappingURL=memory-hub-tier-enforcement.util.js.map