import { vendorRepository } from './vendor.repository.js';
import { userRepository } from '../user/user.repository.js';
import {} from './vendor.types.js';
import {} from '@prisma/client';
export const vendorService = {
    // ── Vendor Space ──────────────────────────
    getAllSpaces: (requestingRole, tenantId) => {
        if (requestingRole === 'SUPER_ADMIN')
            return vendorRepository.findAllSpaces();
        return vendorRepository.findAllSpaces(tenantId ?? undefined);
    },
    getSpaceById: async (id) => {
        const space = await vendorRepository.findSpaceById(id);
        if (!space)
            throw new Error('Vendor space not found');
        return space;
    },
    findNearbyVendors: (latitude, longitude, radiusKm) => vendorRepository.findSpacesNearLocation(latitude, longitude, radiusKm),
    createSpace: (userId, data) => vendorRepository.createSpace(userId, data),
    updateSpace: async (id, userId, data) => {
        await vendorService.getSpaceById(id);
        return vendorRepository.updateSpace(id, userId, data);
    },
    archiveSpace: async (id, userId) => {
        await vendorService.getSpaceById(id);
        return vendorRepository.archiveSpace(id, userId);
    },
    // ── Vendor User Assignment ────────────────
    assignVendorUser: async (vendorSpaceId, userId) => {
        await vendorService.getSpaceById(vendorSpaceId);
        const user = await userRepository.findById(userId);
        if (!user)
            throw new Error('User not found');
        if (user.role !== 'EVENT_VENDOR') {
            throw new Error('User must have EVENT_VENDOR role to be assigned to a vendor space');
        }
        return vendorRepository.assignVendorUser(vendorSpaceId, userId);
    },
    // ── Vendor Service ────────────────────────
    getAllServices: (vendorSpaceId) => vendorRepository.findAllServices(vendorSpaceId),
    getServiceById: async (id) => {
        const service = await vendorRepository.findServiceById(id);
        if (!service)
            throw new Error('Vendor service not found');
        return service;
    },
    createService: (vendorSpaceId, userId, data) => vendorRepository.createService(vendorSpaceId, userId, data),
    updateService: async (id, userId, data) => {
        await vendorService.getServiceById(id);
        return vendorRepository.updateService(id, userId, data);
    },
    archiveService: async (id, userId) => {
        await vendorService.getServiceById(id);
        return vendorRepository.archiveService(id, userId);
    },
    // ── Product ───────────────────────────────
    getAllProducts: (vendorServiceId) => vendorRepository.findAllProducts(vendorServiceId),
    getProductById: async (id) => {
        const product = await vendorRepository.findProductById(id);
        if (!product)
            throw new Error('Product not found');
        return product;
    },
    createProduct: (vendorServiceId, userId, data) => vendorRepository.createProduct(vendorServiceId, userId, data),
    updateProduct: async (id, userId, data) => {
        await vendorService.getProductById(id);
        return vendorRepository.updateProduct(id, userId, data);
    },
    archiveProduct: async (id, userId) => {
        await vendorService.getProductById(id);
        return vendorRepository.archiveProduct(id, userId);
    },
};
//# sourceMappingURL=vendor.service.js.map