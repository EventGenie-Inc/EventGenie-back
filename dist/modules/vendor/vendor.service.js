import { vendorRepository } from './vendor.repository.js';
import { userRepository } from '../user/user.repository.js';
import { eventService } from '../event/event.service.js';
import { assertVendorSpaceCreatable, assertVendorMarketplaceAccessible } from './vendor-tier-enforcement.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {} from './vendor.types.js';
import {} from '@prisma/client';
// ─────────────────────────────────────────
//  VENDOR SERVICE
//
//  MANAGEMENT (space CRUD, service/product CRUD, user assignment) is
//  strictly tenant-scoped — every single-record method below gates
//  through a scoped lookup, exactly like every other module in this
//  codebase. DISCOVERY (findNearbyVendors, getBrowseVendors,
//  getNearbyVendorsForEvent) is the deliberate exception — see those
//  methods for why.
//
//  VendorSpace.tenantId is nullable — a SUPER_ADMIN-managed vendor
//  space with no owning tenant is a real, distinct case (not an
//  oversight): nobody's tenant plan applies to it, and no TENANT_ADMIN
//  can manage it (their tenant-scoped lookups will never match a null
//  tenantId). Only SUPER_ADMIN can create, edit, or assign users to one.
//
//  DISCOVERY RESULTS deliberately include full vendor contact details
//  (email, phoneNumber) — recorded decision, not an oversight: without
//  in-app messaging there is no other way for an organiser to reach a
//  vendor they've found. Known, accepted tradeoff: any CELEBRATE/ELEVATE
//  tenant can retrieve every vendor's contact info across the platform
//  via these endpoints — a scrapeable directory. Revisit when in-app
//  messaging exists, or if discovery abuse appears. Do not "fix" this
//  by stripping fields here without re-raising it first.
// ─────────────────────────────────────────
export const vendorService = {
    // ── Vendor Space ──────────────────────────
    getAllSpaces: (requestingRole, tenantId, includeArchived = false) => {
        if (requestingRole === 'SUPER_ADMIN')
            return vendorRepository.findAllSpaces(undefined, includeArchived);
        return vendorRepository.findAllSpaces(tenantId ?? undefined, includeArchived);
    },
    // includeArchived is true only for the restore flow below (and a
    // tenant admin explicitly browsing their own archived spaces via
    // getAllSpaces) — every other call site relies on the default so an
    // archived space stays a 404, cross-tenant-access included.
    getSpaceById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const space = requestingRole === 'SUPER_ADMIN'
            ? await vendorRepository.findSpaceById(id, includeArchived)
            : await vendorRepository.findSpaceById(id, includeArchived, tenantId ?? undefined);
        if (!space)
            throw new HttpError(404, 'Vendor space not found');
        return space;
    },
    // ─────────────────────────────────────────
    //  DISCOVERY — deliberately CROSS-TENANT.
    //
    //  This is the marketplace: an organiser searching "vendors near my
    //  venue" must see every tenant's vendors, not their own tenant's
    //  alone (which would usually be zero or a handful and defeat the
    //  point of a marketplace). No tenantId is threaded into this call at
    //  all — see vendor.repository.ts's findSpacesNearLocation for the
    //  query itself and its own comment.
    // ─────────────────────────────────────────
    findNearbyVendors: async (latitude, longitude, requestingTenantId, radiusKm) => {
        // Gate on the SEARCHING tenant's plan, not a target being created —
        // a SPARK tenant is blocked from the marketplace both as a vendor
        // (assertVendorSpaceCreatable) and as a searcher (here).
        await assertVendorMarketplaceAccessible(requestingTenantId);
        return vendorRepository.findSpacesNearLocation(latitude, longitude, radiusKm);
    },
    // ─────────────────────────────────────────
    //  GENERAL BROWSE — the third discovery surface. Cross-tenant, same
    //  gate as findNearbyVendors, but no location filter at all — "show
    //  me the whole marketplace." isPriority is present here too, same as
    //  the other two; a vendor being priority in nearby search but not in
    //  browse (or vice versa) would be worse than no priority feature at
    //  all.
    // ─────────────────────────────────────────
    getBrowseVendors: async (requestingTenantId) => {
        await assertVendorMarketplaceAccessible(requestingTenantId);
        return vendorRepository.findSpacesForBrowse();
    },
    // ─────────────────────────────────────────
    //  EVENT-SCOPED DISCOVERY — the subtle one.
    //
    //  The EVENT is resolved through the normal tenant-scoped path
    //  (eventService.getById — 404s on a cross-tenant eventId, same as
    //  every other event-scoped read), but the SEARCH performed once its
    //  coordinates are known is NOT tenant-scoped — same marketplace
    //  reasoning as findNearbyVendors above. Only the "which event am I
    //  allowed to look up" question is tenant-scoped; "which vendors can
    //  it see" deliberately is not.
    // ─────────────────────────────────────────
    getNearbyVendorsForEvent: async (eventId, requestingRole, tenantId, radiusKm) => {
        await assertVendorMarketplaceAccessible(tenantId);
        const event = await eventService.getById(eventId, requestingRole, tenantId);
        if (event.latitude === null || event.longitude === null) {
            throw new HttpError(422, "This event doesn't have coordinates yet. Search for and select its address before looking for nearby vendors.");
        }
        // Event.latitude/longitude are Prisma Decimal, same as VendorSpace's
        // (see vendor.repository.ts's withPlainCoords) — converted explicitly
        // here since event.repository.ts doesn't do this conversion itself
        // (a pre-existing gap flagged in an earlier batch's report; out of
        // scope for the vendor module to fix at the source, but it has to be
        // handled at this call site regardless, or the Haversine math below
        // silently breaks on a Decimal instance instead of a number).
        const latitude = Number(event.latitude);
        const longitude = Number(event.longitude);
        return vendorRepository.findSpacesNearLocation(latitude, longitude, radiusKm);
    },
    createSpace: async (userId, requestingRole, requestingTenantId, data) => {
        // TENANT_ADMIN: tenantId is forced to the requester's own tenant —
        // data.tenantId is never read on this path (mirrors userService.create's
        // exact reasoning: a client-supplied tenantId here would let a
        // Tenant Admin create a space for another tenant). SUPER_ADMIN may
        // specify any tenantId, or omit it for a platform-level space.
        if (requestingRole !== 'SUPER_ADMIN' && !requestingTenantId) {
            throw new HttpError(400, 'User has no associated tenant');
        }
        const resolvedTenantId = requestingRole === 'SUPER_ADMIN' ? (data.tenantId ?? null) : requestingTenantId;
        await assertVendorSpaceCreatable(resolvedTenantId);
        return vendorRepository.createSpace(userId, { ...data, ...(resolvedTenantId !== null && { tenantId: resolvedTenantId }) });
    },
    updateSpace: async (id, userId, requestingRole, tenantId, data) => {
        await vendorService.getSpaceById(id, requestingRole, tenantId); // throws 404 if wrong tenant
        return vendorRepository.updateSpace(id, userId, data);
    },
    archiveSpace: async (id, userId, requestingRole, tenantId) => {
        await vendorService.getSpaceById(id, requestingRole, tenantId);
        return vendorRepository.archiveSpace(id, userId);
    },
    // Self-service restore (TENANT_ADMIN of the owning tenant, or
    // SUPER_ADMIN) — mirrors Guest/Invite's precedent (already
    // self-service, transitively tenant-scoped) rather than Event/User/
    // Tenant's precedent (SUPER_ADMIN-only "support" action), since vendor
    // space management is already self-service at every other step.
    reactivateSpace: async (id, userId, requestingRole, tenantId) => {
        // Must look up including archived — the whole point of reactivate is
        // to find a vendor space that is currently archived and un-archive it.
        await vendorService.getSpaceById(id, requestingRole, tenantId, true);
        await vendorRepository.reactivateSpace(id, userId);
        return vendorService.getSpaceById(id, requestingRole, tenantId, true);
    },
    // ── Vendor User Assignment (VendorSpaceUser join table) ───────────
    //
    //  Many-to-many, deliberately unrestricted in both directions: one
    //  vendor user across several spaces (the reason for this migration —
    //  a person may run more than one vendor business), and several users
    //  on one space (not explicitly asked for, but falls out of a join
    //  table and is plausible — a vendor business with multiple staff).
    //  No concrete reason found to cap either side, so neither is capped.
    assignVendorUser: async (vendorSpaceId, actingUserId, requestingRole, requestingTenantId, targetUserId) => {
        // 404s if the space belongs to a different tenant than the caller.
        const space = await vendorService.getSpaceById(vendorSpaceId, requestingRole, requestingTenantId);
        const user = await userRepository.findById(targetUserId);
        if (!user)
            throw new HttpError(404, 'User not found');
        if (user.role !== 'EVENT_VENDOR') {
            throw new HttpError(400, 'User must have EVENT_VENDOR role to be assigned to a vendor space');
        }
        // Cross-tenant guard: a vendor space owned by tenant A must only
        // ever get users from tenant A assigned to it. Reported as the SAME
        // 404 as a genuinely nonexistent user, per STEERING's cross-tenant
        // rule — confirming a real user exists in a different tenant is
        // itself a leak. Skipped when the space has no tenant (a
        // SUPER_ADMIN-managed, platform-level space) — nothing to match.
        if (space.tenantId !== null && user.tenantId !== space.tenantId) {
            throw new HttpError(404, 'User not found');
        }
        const existing = await vendorRepository.findMembership(vendorSpaceId, targetUserId);
        if (existing) {
            throw new HttpError(409, 'This user is already assigned to this vendor space');
        }
        return vendorRepository.assignVendorUser(vendorSpaceId, targetUserId, actingUserId);
    },
    unassignVendorUser: async (vendorSpaceId, requestingRole, requestingTenantId, targetUserId) => {
        // Same two checks as assign, in the same order — unassign must not
        // reintroduce the hole the single-FK version was fixed for either.
        const space = await vendorService.getSpaceById(vendorSpaceId, requestingRole, requestingTenantId);
        const user = await userRepository.findById(targetUserId);
        if (!user)
            throw new HttpError(404, 'User not found');
        if (space.tenantId !== null && user.tenantId !== space.tenantId) {
            throw new HttpError(404, 'User not found');
        }
        const existing = await vendorRepository.findMembership(vendorSpaceId, targetUserId);
        if (!existing) {
            throw new HttpError(404, 'This user is not assigned to this vendor space');
        }
        return vendorRepository.unassignVendorUser(vendorSpaceId, targetUserId);
    },
    // Self-service: "which spaces do I personally manage" — no tenant
    // scoping needed, membership itself is the scope (a vendor user's
    // memberships were only ever created within their own tenant's
    // spaces, enforced above at assign time).
    getMySpaces: (userId) => vendorRepository.findSpacesForUser(userId),
    // ── Vendor Service ────────────────────────
    // VendorService has no tenantId of its own — ownership is transitive
    // through vendorSpaceId. Every method gates through getSpaceById
    // first, exactly like event-day/guest/invite gate through
    // eventService.getById.
    getAllServices: async (vendorSpaceId, requestingRole, tenantId, includeArchived = false) => {
        await vendorService.getSpaceById(vendorSpaceId, requestingRole, tenantId); // throws 404 if wrong tenant
        return vendorRepository.findAllServices(vendorSpaceId, includeArchived);
    },
    getServiceById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const service = await vendorRepository.findServiceById(id, includeArchived);
        if (!service)
            throw new HttpError(404, 'Vendor service not found');
        // Ownership gate via the parent space — throws 404 if it belongs to
        // a different tenant, indistinguishable from the service not
        // existing. Deliberately uses the DEFAULT (non-archived-required)
        // lookup even when includeArchived is true for the service itself —
        // same precedent as invite.service.ts's reactivate: a child can't be
        // restored while its parent is still archived; restore the parent
        // first.
        await vendorService.getSpaceById(service.vendorSpaceId, requestingRole, tenantId);
        return service;
    },
    createService: async (vendorSpaceId, userId, requestingRole, tenantId, data) => {
        await vendorService.getSpaceById(vendorSpaceId, requestingRole, tenantId);
        return vendorRepository.createService(vendorSpaceId, userId, data);
    },
    updateService: async (id, userId, requestingRole, tenantId, data) => {
        await vendorService.getServiceById(id, requestingRole, tenantId);
        return vendorRepository.updateService(id, userId, data);
    },
    archiveService: async (id, userId, requestingRole, tenantId) => {
        await vendorService.getServiceById(id, requestingRole, tenantId);
        return vendorRepository.archiveService(id, userId);
    },
    reactivateService: async (id, userId, requestingRole, tenantId) => {
        await vendorService.getServiceById(id, requestingRole, tenantId, true);
        await vendorRepository.reactivateService(id, userId);
        return vendorService.getServiceById(id, requestingRole, tenantId, true);
    },
    // ── Product ───────────────────────────────
    // Product has no tenantId either — ownership is transitive two hops
    // up (vendorServiceId -> VendorService.vendorSpaceId ->
    // VendorSpace.tenantId), enforced by gating through getServiceById,
    // which itself cascades into getSpaceById.
    getAllProducts: async (vendorServiceId, requestingRole, tenantId, includeArchived = false) => {
        await vendorService.getServiceById(vendorServiceId, requestingRole, tenantId);
        return vendorRepository.findAllProducts(vendorServiceId, includeArchived);
    },
    getProductById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const product = await vendorRepository.findProductById(id, includeArchived);
        if (!product)
            throw new HttpError(404, 'Product not found');
        await vendorService.getServiceById(product.vendorServiceId, requestingRole, tenantId);
        return product;
    },
    createProduct: async (vendorServiceId, userId, requestingRole, tenantId, data) => {
        await vendorService.getServiceById(vendorServiceId, requestingRole, tenantId);
        return vendorRepository.createProduct(vendorServiceId, userId, data);
    },
    updateProduct: async (id, userId, requestingRole, tenantId, data) => {
        await vendorService.getProductById(id, requestingRole, tenantId);
        return vendorRepository.updateProduct(id, userId, data);
    },
    archiveProduct: async (id, userId, requestingRole, tenantId) => {
        await vendorService.getProductById(id, requestingRole, tenantId);
        return vendorRepository.archiveProduct(id, userId);
    },
    reactivateProduct: async (id, userId, requestingRole, tenantId) => {
        await vendorService.getProductById(id, requestingRole, tenantId, true);
        await vendorRepository.reactivateProduct(id, userId);
        return vendorService.getProductById(id, requestingRole, tenantId, true);
    },
};
//# sourceMappingURL=vendor.service.js.map