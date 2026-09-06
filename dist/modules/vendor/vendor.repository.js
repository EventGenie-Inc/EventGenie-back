import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import { isPriorityTier } from './vendor-priority.util.js';
import {} from './vendor.types.js';
// ─────────────────────────────────────────
//  DECIMAL -> NUMBER
//
//  VendorSpace.latitude/longitude and Product.price are Prisma Decimal
//  columns. On read they come back as Decimal instances, which
//  JSON.stringify (via Decimal's own toJSON) renders as STRINGS, not
//  numbers — and distance math (Haversine, bounding-box deltas) needs
//  real numbers, not Decimal objects (no +/-/* operators on them).
//  Converted explicitly here, once, at the repository boundary, so
//  every caller — service layer, JSON response, distance calculation —
//  always sees a plain number. Number(decimal) is the same coercion
//  already used elsewhere in this codebase (rsvp.service.ts's
//  totalPaid calculation).
// ─────────────────────────────────────────
const withPlainCoords = (space) => ({
    ...space,
    latitude: Number(space.latitude),
    longitude: Number(space.longitude),
});
const withPlainPrice = (product) => ({
    ...product,
    price: product.price === null ? null : Number(product.price),
});
// Derives isPriority from the owning tenant's CURRENT tier (see
// vendor-priority.util.ts) and drops the nested tenant object from the
// response — callers get the boolean, not the tenant's tier directly.
// A null tenant (platform-level, tenant-less space) is never priority.
const withPriority = (space) => {
    const { tenant, ...rest } = space;
    return { ...rest, isPriority: isPriorityTier(tenant?.subscriptionTier) };
};
// ─────────────────────────────────────────
//  PROXIMITY — Haversine over a bounding-box pre-filter
//
//  Resolves the "proximity calculation method" open decision: the
//  bounding box alone (kept as the SQL WHERE clause, cheap and
//  index-friendly) returns a SQUARE region, which includes corner
//  points outside the true circular radius. Haversine below computes
//  real great-circle distance in JS to (a) filter those false-positive
//  corners out and (b) sort by actual proximity, and exposes the result
//  as `distanceKm` on every returned space. Still not PostGIS — the
//  existing code comment already flagged that as a future upgrade for
//  accuracy/performance at real scale; this is the honest middle step,
//  not a full solution.
// ─────────────────────────────────────────
const EARTH_RADIUS_KM = 6371;
const haversineDistanceKm = (lat1, lng1, lat2, lng2) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_KM * c;
};
// Resolves "radius defaults and maximums": 50km default (a reasonable
// metro-area search), 200km hard cap (generous for a rural/regional
// search while bounding worst-case scan cost — nothing stops a caller
// from requesting radius=999999 today). Both raised as open decisions
// in the earlier batch report; proceeding with these while flagged.
const DEFAULT_RADIUS_KM = 50;
const MAX_RADIUS_KM = 200;
// ─────────────────────────────────────────
//  RANKING — distance stays primary, priority breaks ties within a
//  ~1km band. ORDER BY round(distanceKm) ASC, isPriority DESC,
//  distanceKm ASC — implemented in JS since distance itself is computed
//  in JS (see Haversine above). Math.round bands are centered on each
//  integer km (2.4 and 2.5 both round to 2 and compete on priority;
//  2.5 and 2.6 land in different bands, band always wins). A 30km
//  ELEVATE vendor must never outrank a 2km CELEBRATE one — banding
//  first, before priority, is what guarantees that.
// ─────────────────────────────────────────
const byBandedDistanceThenPriority = (a, b) => {
    const bandA = Math.round(a.distanceKm);
    const bandB = Math.round(b.distanceKm);
    if (bandA !== bandB)
        return bandA - bandB;
    if (a.isPriority !== b.isPriority)
        return a.isPriority ? -1 : 1;
    return a.distanceKm - b.distanceKm;
};
export const vendorRepository = {
    // ── Vendor Space ──────────────────────────
    findAllSpaces: async (tenantId, includeArchived = false) => {
        const spaces = await prisma.vendorSpace.findMany({
            where: {
                ...(includeArchived ? {} : { isArchived: false }),
                ...(tenantId ? { tenantId } : {}),
            },
            include: {
                vendorSpaceUsers: { where: { user: { isArchived: false } }, include: { user: true } },
                vendorServices: { where: { isArchived: false } },
            },
            orderBy: { createdAt: 'desc' },
        });
        return spaces.map(withPlainCoords);
    },
    // MANAGEMENT lookup — tenant-scoped like every other by-id method in
    // this codebase. This is the one the earlier security audit found
    // missing: findAllSpaces was correctly scoped, this was not.
    findSpaceById: async (id, includeArchived = false, tenantId) => {
        const space = await prisma.vendorSpace.findFirst({
            where: {
                id,
                ...(includeArchived ? {} : { isArchived: false }),
                ...(tenantId ? { tenantId } : {}),
            },
            include: {
                vendorSpaceUsers: { where: { user: { isArchived: false } }, include: { user: true } },
                vendorServices: {
                    where: { isArchived: false },
                    include: { products: { where: { isArchived: false } } },
                },
            },
        });
        if (!space)
            return null;
        return {
            ...withPlainCoords(space),
            vendorServices: space.vendorServices.map((service) => ({
                ...service,
                products: service.products.map(withPlainPrice),
            })),
        };
    },
    countActiveSpacesForTenant: (tenantId) => prisma.vendorSpace.count({ where: { tenantId, isArchived: false } }),
    // ─────────────────────────────────────────
    //  DISCOVERY — deliberately CROSS-TENANT.
    //
    //  This is the marketplace search: an organiser looking for vendors
    //  near their venue must see every tenant's vendors, not just their
    //  own (which would usually be zero or a handful — scoping this to
    //  one tenant would make the marketplace pointless). No tenantId
    //  filter anywhere in this query, on purpose. isArchived/isActive ARE
    //  still applied — this is "cross-tenant", not "cross-status".
    // ─────────────────────────────────────────
    findSpacesNearLocation: async (latitude, longitude, radiusKm = DEFAULT_RADIUS_KM) => {
        const clampedRadiusKm = Math.min(radiusKm, MAX_RADIUS_KM);
        const latDelta = clampedRadiusKm / 111;
        const lngDelta = clampedRadiusKm / (111 * Math.cos((latitude * Math.PI) / 180));
        const candidates = await prisma.vendorSpace.findMany({
            where: {
                isArchived: false,
                isActive: true,
                latitude: { gte: latitude - latDelta, lte: latitude + latDelta },
                longitude: { gte: longitude - lngDelta, lte: longitude + lngDelta },
            },
            include: {
                tenant: { select: { subscriptionTier: true } },
                vendorServices: { where: { isArchived: false } },
            },
        });
        return candidates
            .map((space) => {
            const plain = withPriority(withPlainCoords(space));
            const distanceKm = haversineDistanceKm(latitude, longitude, plain.latitude, plain.longitude);
            return { ...plain, distanceKm };
        })
            .filter((space) => space.distanceKm <= clampedRadiusKm)
            .sort(byBandedDistanceThenPriority);
    },
    // ─────────────────────────────────────────
    //  GENERAL BROWSE — the third discovery surface (Vendor Space
    //  Follow-up, Task 2). Cross-tenant, same as nearby search, but with
    //  no location at all to compute a distance from — priority can
    //  safely be the PRIMARY sort here (no "distant ELEVATE vendor beats
    //  a near CELEBRATE one" risk exists without a distance signal).
    // ─────────────────────────────────────────
    findSpacesForBrowse: async () => {
        const spaces = await prisma.vendorSpace.findMany({
            where: { isArchived: false, isActive: true },
            include: {
                tenant: { select: { subscriptionTier: true } },
                vendorServices: { where: { isArchived: false } },
            },
        });
        return spaces
            .map((space) => withPriority(withPlainCoords(space)))
            .sort((a, b) => {
            if (a.isPriority !== b.isPriority)
                return a.isPriority ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    },
    createSpace: async (userId, data) => {
        const space = await prisma.vendorSpace.create({
            data: {
                name: data.name,
                description: data.description ?? null,
                email: data.email,
                phoneNumber: data.phoneNumber ?? null,
                website: data.website ?? null,
                address: data.address ?? null,
                latitude: data.latitude,
                longitude: data.longitude,
                tenantId: data.tenantId ?? null,
                isVerified: false,
                isActive: true,
                isArchived: false,
                createdBy: userId,
                updatedBy: userId,
            },
        });
        return withPlainCoords(space);
    },
    updateSpace: async (id, userId, data) => {
        const space = await prisma.vendorSpace.update({
            where: { id },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.description !== undefined && { description: data.description ?? null }),
                ...(data.email !== undefined && { email: data.email }),
                ...(data.phoneNumber !== undefined && { phoneNumber: data.phoneNumber ?? null }),
                ...(data.website !== undefined && { website: data.website ?? null }),
                ...(data.address !== undefined && { address: data.address ?? null }),
                ...(data.latitude !== undefined && { latitude: data.latitude }),
                ...(data.longitude !== undefined && { longitude: data.longitude }),
                ...(data.isVerified !== undefined && { isVerified: data.isVerified }),
                ...(data.isActive !== undefined && { isActive: data.isActive }),
                updatedBy: userId,
            },
        });
        return withPlainCoords(space);
    },
    archiveSpace: (id, userId) => prisma.vendorSpace.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    reactivateSpace: (id, userId) => prisma.vendorSpace.update({
        where: { id },
        data: { isArchived: false, updatedBy: userId },
    }),
    // ── Vendor User Assignment (VendorSpaceUser join table) ───────────
    // Many-to-many: one vendor user across several spaces, several users
    // on one space — see vendor.service.ts for the "why no restriction"
    // reasoning. Ownership/role/cross-tenant validation happens in
    // vendor.service.ts before these are called; these writes are
    // intentionally dumb.
    findMembership: (vendorSpaceId, userId) => prisma.vendorSpaceUser.findUnique({
        where: { vendorSpaceId_userId: { vendorSpaceId, userId } },
    }),
    assignVendorUser: (vendorSpaceId, userId, createdBy) => prisma.vendorSpaceUser.create({
        data: { vendorSpaceId, userId, createdBy },
        include: { user: true },
    }),
    unassignVendorUser: (vendorSpaceId, userId) => prisma.vendorSpaceUser.delete({
        where: { vendorSpaceId_userId: { vendorSpaceId, userId } },
    }),
    // "Which spaces does this vendor user manage" — a vendor user's own
    // self-service list (GET /api/vendors/mine). Non-archived spaces
    // only, same convention as every other list.
    findSpacesForUser: async (userId) => {
        const memberships = await prisma.vendorSpaceUser.findMany({
            where: { userId, vendorSpace: { isArchived: false } },
            include: {
                vendorSpace: {
                    include: { vendorServices: { where: { isArchived: false } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        return memberships.map((m) => withPlainCoords(m.vendorSpace));
    },
    // ── Vendor Service ────────────────────────
    // VendorService has no tenantId of its own — ownership is transitive
    // through vendorSpaceId -> VendorSpace.tenantId, enforced in
    // vendor.service.ts by gating through getSpaceById first, exactly
    // like event-day/guest/invite gate through eventService.getById.
    findAllServices: (vendorSpaceId, includeArchived = false) => prisma.vendorService.findMany({
        where: { vendorSpaceId, ...(includeArchived ? {} : { isArchived: false }) },
        include: { products: { where: { isArchived: false } } },
        orderBy: { createdAt: 'desc' },
    }),
    findServiceById: (id, includeArchived = false) => prisma.vendorService.findFirst({
        where: { id, ...(includeArchived ? {} : { isArchived: false }) },
        include: { products: { where: { isArchived: false } } },
    }),
    createService: (vendorSpaceId, userId, data) => prisma.vendorService.create({
        data: {
            vendorSpaceId,
            name: data.name,
            category: data.category,
            description: data.description ?? null,
            operatingDays: data.operatingDays ?? null,
            operatingHours: data.operatingHours ?? null,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    updateService: (id, userId, data) => prisma.vendorService.update({
        where: { id },
        data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.category !== undefined && { category: data.category }),
            ...(data.description !== undefined && { description: data.description ?? null }),
            ...(data.operatingDays !== undefined && { operatingDays: data.operatingDays ?? null }),
            ...(data.operatingHours !== undefined && { operatingHours: data.operatingHours ?? null }),
            updatedBy: userId,
        },
    }),
    archiveService: (id, userId) => prisma.vendorService.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    reactivateService: (id, userId) => prisma.vendorService.update({
        where: { id },
        data: { isArchived: false, updatedBy: userId },
    }),
    // ── Product ───────────────────────────────
    // Product has no tenantId of its own either — ownership is transitive
    // two hops up (vendorServiceId -> VendorService.vendorSpaceId ->
    // VendorSpace.tenantId), enforced in vendor.service.ts by gating
    // through getServiceById (which itself gates through getSpaceById).
    findAllProducts: async (vendorServiceId, includeArchived = false) => {
        const products = await prisma.product.findMany({
            where: { vendorServiceId, ...(includeArchived ? {} : { isArchived: false }) },
            orderBy: { createdAt: 'desc' },
        });
        return products.map(withPlainPrice);
    },
    findProductById: async (id, includeArchived = false) => {
        const product = await prisma.product.findFirst({
            where: { id, ...(includeArchived ? {} : { isArchived: false }) },
        });
        return product ? withPlainPrice(product) : null;
    },
    createProduct: async (vendorServiceId, userId, data) => {
        const product = await prisma.product.create({
            data: {
                vendorServiceId,
                name: data.name,
                description: data.description ?? null,
                price: data.price ?? null,
                currency: data.currency ?? 'ZAR',
                imageUrls: data.imageUrls ?? [],
                isAvailable: true,
                isArchived: false,
                createdBy: userId,
                updatedBy: userId,
            },
        });
        return withPlainPrice(product);
    },
    updateProduct: async (id, userId, data) => {
        const product = await prisma.product.update({
            where: { id },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.description !== undefined && { description: data.description ?? null }),
                ...(data.price !== undefined && { price: data.price ?? null }),
                ...(data.currency !== undefined && { currency: data.currency }),
                ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
                ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
                updatedBy: userId,
            },
        });
        return withPlainPrice(product);
    },
    archiveProduct: (id, userId) => prisma.product.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    reactivateProduct: (id, userId) => prisma.product.update({
        where: { id },
        data: { isArchived: false, updatedBy: userId },
    }),
};
//# sourceMappingURL=vendor.repository.js.map