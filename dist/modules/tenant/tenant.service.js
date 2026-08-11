import { tenantRepository } from './tenant.repository.js';
import {} from './tenant.types.js';
export const tenantService = {
    getAll: () => tenantRepository.findAll(),
    getById: async (id) => {
        const tenant = await tenantRepository.findById(id);
        if (!tenant)
            throw new Error('Tenant not found');
        return tenant;
    },
    create: async (data) => {
        const existing = await tenantRepository.findBySlug(data.slug);
        if (existing)
            throw new Error('A tenant with this slug already exists');
        return tenantRepository.create(data);
    },
    update: async (id, data) => {
        await tenantService.getById(id);
        return tenantRepository.update(id, data);
    },
    archive: async (id) => {
        await tenantService.getById(id);
        return tenantRepository.archive(id);
    },
};
//# sourceMappingURL=tenant.service.js.map