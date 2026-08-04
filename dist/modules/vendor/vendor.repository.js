import prisma from '../../shared/prisma/prisma.client.js';
import {} from './vendor.types.js';
export const vendorRepository = {
    // ── Vendor Space ──────────────────────────
    findAllSpaces: (tenantId) => prisma.vendorSpace.findMany({
        where: {
            isArchived: false,
            ...(tenantId ? { tenantId } : {}),
        },
        include: {
            users: { where: { role: 'EVENT_VENDOR', isArchived: false } },
            vendorServices: { where: { isArchived: false } },
        },
        orderBy: { createdAt: 'desc' },
    }),
    findSpaceById: (id) => prisma.vendorSpace.findFirst({
        where: { id, isArchived: false },
        include: {
            users: { where: { role: 'EVENT_VENDOR', isArchived: false } },
            vendorServices: {
                where: { isArchived: false },
                include: { products: { where: { isArchived: false } } },
            },
        },
    }),
    // Proximity search — finds vendors within ~radius km of a lat/lng point
    // Uses basic bounding box for now; can be upgraded to PostGIS later
    findSpacesNearLocation: (latitude, longitude, radiusKm = 50) => {
        const latDelta = radiusKm / 111;
        const lngDelta = radiusKm / (111 * Math.cos((latitude * Math.PI) / 180));
        return prisma.vendorSpace.findMany({
            where: {
                isArchived: false,
                isActive: true,
                latitude: { gte: latitude - latDelta, lte: latitude + latDelta },
                longitude: { gte: longitude - lngDelta, lte: longitude + lngDelta },
            },
            include: { vendorServices: { where: { isArchived: false } } },
            orderBy: { createdAt: 'desc' },
        });
    },
    createSpace: (userId, data) => prisma.vendorSpace.create({
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
    }),
    updateSpace: (id, userId, data) => prisma.vendorSpace.update({
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
    }),
    archiveSpace: (id, userId) => prisma.vendorSpace.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    // ── Vendor User Assignment ────────────────
    // A vendor "user" is now just a platform User with role EVENT_VENDOR,
    // linked via User.vendorSpaceId. This is a deliberate exception writing
    // across model boundaries within this repository file, since
    // User.vendorSpaceId is effectively owned jointly by both modules.
    assignVendorUser: (vendorSpaceId, userId) => prisma.user.update({
        where: { id: userId },
        data: { vendorSpaceId },
    }),
    // ── Vendor Service ────────────────────────
    findAllServices: (vendorSpaceId) => prisma.vendorService.findMany({
        where: { vendorSpaceId, isArchived: false },
        include: { products: { where: { isArchived: false } } },
        orderBy: { createdAt: 'desc' },
    }),
    findServiceById: (id) => prisma.vendorService.findFirst({
        where: { id, isArchived: false },
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
    // ── Product ───────────────────────────────
    findAllProducts: (vendorServiceId) => prisma.product.findMany({
        where: { vendorServiceId, isArchived: false },
        orderBy: { createdAt: 'desc' },
    }),
    findProductById: (id) => prisma.product.findFirst({ where: { id, isArchived: false } }),
    createProduct: (vendorServiceId, userId, data) => prisma.product.create({
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
    }),
    updateProduct: (id, userId, data) => prisma.product.update({
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
    }),
    archiveProduct: (id, userId) => prisma.product.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=vendor.repository.js.map