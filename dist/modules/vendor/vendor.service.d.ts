import { type CreateVendorSpaceDto, type UpdateVendorSpaceDto, type CreateVendorServiceDto, type UpdateVendorServiceDto, type CreateProductDto, type UpdateProductDto } from './vendor.types.js';
import { type PlatformRole } from '@prisma/client';
export declare const vendorService: {
    getAllSpaces: (requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<(Omit<{
        vendorSpaceUsers: ({
            user: {
                id: string;
                email: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                tenantId: string | null;
                firebaseUid: string;
                username: string;
                role: import("@prisma/client").$Enums.PlatformRole;
                isActive: boolean;
            };
        } & {
            id: string;
            createdAt: Date;
            createdBy: string;
            vendorSpaceId: string;
            userId: string;
        })[];
        vendorServices: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
    } & {
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal;
        longitude: import("@prisma/client-runtime-utils").Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    })[]>;
    getSpaceById: (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<{
        vendorServices: {
            products: (Omit<{
                name: string;
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                description: string | null;
                createdBy: string;
                updatedBy: string;
                price: import("@prisma/client-runtime-utils").Decimal | null;
                currency: string;
                isAvailable: boolean;
                vendorServiceId: string;
                imageUrls: string[];
            }, "price"> & {
                price: number | null;
            })[];
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
        vendorSpaceUsers: ({
            user: {
                id: string;
                email: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                tenantId: string | null;
                firebaseUid: string;
                username: string;
                role: import("@prisma/client").$Enums.PlatformRole;
                isActive: boolean;
            };
        } & {
            id: string;
            createdAt: Date;
            createdBy: string;
            vendorSpaceId: string;
            userId: string;
        })[];
        latitude: number;
        longitude: number;
    }>;
    findNearbyVendors: (latitude: number, longitude: number, requestingTenantId: string | null, radiusKm?: number) => Promise<{
        distanceKm: number;
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: number;
        longitude: number;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
        vendorServices: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
        isPriority: boolean;
    }[]>;
    getBrowseVendors: (requestingTenantId: string | null) => Promise<(Omit<Omit<{
        tenant: {
            subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        } | null;
        vendorServices: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
    } & {
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal;
        longitude: import("@prisma/client-runtime-utils").Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    }, "tenant"> & {
        isPriority: boolean;
    })[]>;
    getNearbyVendorsForEvent: (eventId: string, requestingRole: PlatformRole, tenantId: string | null, radiusKm?: number) => Promise<{
        distanceKm: number;
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: number;
        longitude: number;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
        vendorServices: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
        isPriority: boolean;
    }[]>;
    createSpace: (userId: string, requestingRole: PlatformRole, requestingTenantId: string | null, data: CreateVendorSpaceDto) => Promise<Omit<{
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal;
        longitude: import("@prisma/client-runtime-utils").Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    }>;
    updateSpace: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateVendorSpaceDto) => Promise<Omit<{
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal;
        longitude: import("@prisma/client-runtime-utils").Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    }>;
    archiveSpace: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal;
        longitude: import("@prisma/client-runtime-utils").Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }>;
    reactivateSpace: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        vendorServices: {
            products: (Omit<{
                name: string;
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                description: string | null;
                createdBy: string;
                updatedBy: string;
                price: import("@prisma/client-runtime-utils").Decimal | null;
                currency: string;
                isAvailable: boolean;
                vendorServiceId: string;
                imageUrls: string[];
            }, "price"> & {
                price: number | null;
            })[];
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
        vendorSpaceUsers: ({
            user: {
                id: string;
                email: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                tenantId: string | null;
                firebaseUid: string;
                username: string;
                role: import("@prisma/client").$Enums.PlatformRole;
                isActive: boolean;
            };
        } & {
            id: string;
            createdAt: Date;
            createdBy: string;
            vendorSpaceId: string;
            userId: string;
        })[];
        latitude: number;
        longitude: number;
    }>;
    assignVendorUser: (vendorSpaceId: string, actingUserId: string, requestingRole: PlatformRole, requestingTenantId: string | null, targetUserId: string) => Promise<{
        user: {
            id: string;
            email: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string | null;
            firebaseUid: string;
            username: string;
            role: import("@prisma/client").$Enums.PlatformRole;
            isActive: boolean;
        };
    } & {
        id: string;
        createdAt: Date;
        createdBy: string;
        vendorSpaceId: string;
        userId: string;
    }>;
    unassignVendorUser: (vendorSpaceId: string, requestingRole: PlatformRole, requestingTenantId: string | null, targetUserId: string) => Promise<{
        id: string;
        createdAt: Date;
        createdBy: string;
        vendorSpaceId: string;
        userId: string;
    }>;
    getMySpaces: (userId: string) => Promise<(Omit<{
        vendorServices: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            vendorSpaceId: string;
            category: import("@prisma/client").$Enums.VendorCategory;
            operatingDays: string | null;
            operatingHours: string | null;
        }[];
    } & {
        name: string;
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        isActive: boolean;
        description: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal;
        longitude: import("@prisma/client-runtime-utils").Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    })[]>;
    getAllServices: (vendorSpaceId: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<({
        products: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            price: import("@prisma/client-runtime-utils").Decimal | null;
            currency: string;
            isAvailable: boolean;
            vendorServiceId: string;
            imageUrls: string[];
        }[];
    } & {
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        vendorSpaceId: string;
        category: import("@prisma/client").$Enums.VendorCategory;
        operatingDays: string | null;
        operatingHours: string | null;
    })[]>;
    getServiceById: (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<{
        products: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            price: import("@prisma/client-runtime-utils").Decimal | null;
            currency: string;
            isAvailable: boolean;
            vendorServiceId: string;
            imageUrls: string[];
        }[];
    } & {
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        vendorSpaceId: string;
        category: import("@prisma/client").$Enums.VendorCategory;
        operatingDays: string | null;
        operatingHours: string | null;
    }>;
    createService: (vendorSpaceId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateVendorServiceDto) => Promise<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        vendorSpaceId: string;
        category: import("@prisma/client").$Enums.VendorCategory;
        operatingDays: string | null;
        operatingHours: string | null;
    }>;
    updateService: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateVendorServiceDto) => Promise<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        vendorSpaceId: string;
        category: import("@prisma/client").$Enums.VendorCategory;
        operatingDays: string | null;
        operatingHours: string | null;
    }>;
    archiveService: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        vendorSpaceId: string;
        category: import("@prisma/client").$Enums.VendorCategory;
        operatingDays: string | null;
        operatingHours: string | null;
    }>;
    reactivateService: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        products: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            price: import("@prisma/client-runtime-utils").Decimal | null;
            currency: string;
            isAvailable: boolean;
            vendorServiceId: string;
            imageUrls: string[];
        }[];
    } & {
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        vendorSpaceId: string;
        category: import("@prisma/client").$Enums.VendorCategory;
        operatingDays: string | null;
        operatingHours: string | null;
    }>;
    getAllProducts: (vendorServiceId: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<(Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: import("@prisma/client-runtime-utils").Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    })[]>;
    getProductById: (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: import("@prisma/client-runtime-utils").Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }>;
    createProduct: (vendorServiceId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateProductDto) => Promise<Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: import("@prisma/client-runtime-utils").Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }>;
    updateProduct: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateProductDto) => Promise<Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: import("@prisma/client-runtime-utils").Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }>;
    archiveProduct: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: import("@prisma/client-runtime-utils").Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }>;
    reactivateProduct: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: import("@prisma/client-runtime-utils").Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }>;
};
//# sourceMappingURL=vendor.service.d.ts.map