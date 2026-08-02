import { vendorRepository } from './vendor.repository.js';
import { userRepository } from '../user/user.repository.js';
import {
  type CreateVendorSpaceDto,
  type UpdateVendorSpaceDto,
  type CreateVendorServiceDto,
  type UpdateVendorServiceDto,
  type CreateProductDto,
  type UpdateProductDto,
} from './vendor.types.js';
import { type PlatformRole } from '@prisma/client';

export const vendorService = {

  // ── Vendor Space ──────────────────────────

  getAllSpaces: (requestingRole: PlatformRole, tenantId: string | null) => {
    if (requestingRole === 'SUPER_ADMIN') return vendorRepository.findAllSpaces();
    return vendorRepository.findAllSpaces(tenantId ?? undefined);
  },

  getSpaceById: async (id: string) => {
    const space = await vendorRepository.findSpaceById(id);
    if (!space) throw new Error('Vendor space not found');
    return space;
  },

  findNearbyVendors: (latitude: number, longitude: number, radiusKm?: number) =>
    vendorRepository.findSpacesNearLocation(latitude, longitude, radiusKm),

  createSpace: (userId: string, data: CreateVendorSpaceDto) =>
    vendorRepository.createSpace(userId, data),

  updateSpace: async (id: string, userId: string, data: UpdateVendorSpaceDto) => {
    await vendorService.getSpaceById(id);
    return vendorRepository.updateSpace(id, userId, data);
  },

  archiveSpace: async (id: string, userId: string) => {
    await vendorService.getSpaceById(id);
    return vendorRepository.archiveSpace(id, userId);
  },

  // ── Vendor User Assignment ────────────────

  assignVendorUser: async (vendorSpaceId: string, userId: string) => {
    await vendorService.getSpaceById(vendorSpaceId);

    const user = await userRepository.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.role !== 'EVENT_VENDOR') {
      throw new Error('User must have EVENT_VENDOR role to be assigned to a vendor space');
    }

    return vendorRepository.assignVendorUser(vendorSpaceId, userId);
  },

  // ── Vendor Service ────────────────────────

  getAllServices: (vendorSpaceId: string) =>
    vendorRepository.findAllServices(vendorSpaceId),

  getServiceById: async (id: string) => {
    const service = await vendorRepository.findServiceById(id);
    if (!service) throw new Error('Vendor service not found');
    return service;
  },

  createService: (vendorSpaceId: string, userId: string, data: CreateVendorServiceDto) =>
    vendorRepository.createService(vendorSpaceId, userId, data),

  updateService: async (id: string, userId: string, data: UpdateVendorServiceDto) => {
    await vendorService.getServiceById(id);
    return vendorRepository.updateService(id, userId, data);
  },

  archiveService: async (id: string, userId: string) => {
    await vendorService.getServiceById(id);
    return vendorRepository.archiveService(id, userId);
  },

  // ── Product ───────────────────────────────

  getAllProducts: (vendorServiceId: string) =>
    vendorRepository.findAllProducts(vendorServiceId),

  getProductById: async (id: string) => {
    const product = await vendorRepository.findProductById(id);
    if (!product) throw new Error('Product not found');
    return product;
  },

  createProduct: (vendorServiceId: string, userId: string, data: CreateProductDto) =>
    vendorRepository.createProduct(vendorServiceId, userId, data),

  updateProduct: async (id: string, userId: string, data: UpdateProductDto) => {
    await vendorService.getProductById(id);
    return vendorRepository.updateProduct(id, userId, data);
  },

  archiveProduct: async (id: string, userId: string) => {
    await vendorService.getProductById(id);
    return vendorRepository.archiveProduct(id, userId);
  },
};