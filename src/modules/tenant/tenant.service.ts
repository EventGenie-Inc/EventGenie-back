import { tenantRepository } from './tenant.repository.js';
import { type CreateTenantDto, type UpdateTenantDto } from './tenant.types.js';

export const tenantService = {

  getAll: () => tenantRepository.findAll(),

  getById: async (id: string) => {
    const tenant = await tenantRepository.findById(id);
    if (!tenant) throw new Error('Tenant not found');
    return tenant;
  },

  create: async (data: CreateTenantDto) => {
    const existing = await tenantRepository.findBySlug(data.slug);
    if (existing) throw new Error('A tenant with this slug already exists');
    return tenantRepository.create(data);
  },

  update: async (id: string, data: UpdateTenantDto) => {
    await tenantService.getById(id);
    return tenantRepository.update(id, data);
  },

  archive: async (id: string) => {
    await tenantService.getById(id);
    return tenantRepository.archive(id);
  },
};