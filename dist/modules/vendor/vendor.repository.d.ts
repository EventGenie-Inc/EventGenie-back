import { type Prisma } from '@prisma/client';
import { type CreateVendorSpaceDto, type UpdateVendorSpaceDto, type CreateVendorServiceDto, type UpdateVendorServiceDto, type CreateProductDto, type UpdateProductDto } from './vendor.types.js';
export declare const vendorRepository: {
    findAllSpaces: (tenantId?: string, includeArchived?: boolean) => Promise<(Omit<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    })[]>;
    findSpaceById: (id: string, includeArchived?: boolean, tenantId?: string) => Promise<{
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
                price: Prisma.Decimal | null;
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
    } | null>;
    countActiveSpacesForTenant: (tenantId: string) => Prisma.PrismaPromise<number>;
    findSpacesNearLocation: (latitude: number, longitude: number, radiusKm?: number) => Promise<{
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
    findSpacesForBrowse: () => Promise<(Omit<Omit<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
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
    createSpace: (userId: string, data: CreateVendorSpaceDto) => Promise<Omit<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    }>;
    updateSpace: (id: string, userId: string, data: UpdateVendorSpaceDto) => Promise<Omit<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    }>;
    archiveSpace: (id: string, userId: string) => Prisma.Prisma__VendorSpaceClient<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    reactivateSpace: (id: string, userId: string) => Prisma.Prisma__VendorSpaceClient<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    findMembership: (vendorSpaceId: string, userId: string) => Prisma.Prisma__VendorSpaceUserClient<{
        id: string;
        createdAt: Date;
        createdBy: string;
        vendorSpaceId: string;
        userId: string;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    assignVendorUser: (vendorSpaceId: string, userId: string, createdBy: string) => Prisma.Prisma__VendorSpaceUserClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    unassignVendorUser: (vendorSpaceId: string, userId: string) => Prisma.Prisma__VendorSpaceUserClient<{
        id: string;
        createdAt: Date;
        createdBy: string;
        vendorSpaceId: string;
        userId: string;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    findSpacesForUser: (userId: string) => Promise<(Omit<{
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
        latitude: Prisma.Decimal;
        longitude: Prisma.Decimal;
        createdBy: string;
        updatedBy: string;
        phoneNumber: string | null;
        website: string | null;
        isVerified: boolean;
    }, "latitude" | "longitude"> & {
        latitude: number;
        longitude: number;
    })[]>;
    findAllServices: (vendorSpaceId: string, includeArchived?: boolean) => Prisma.PrismaPromise<({
        products: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            price: Prisma.Decimal | null;
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
    findServiceById: (id: string, includeArchived?: boolean) => Prisma.Prisma__VendorServiceClient<({
        products: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            price: Prisma.Decimal | null;
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    createService: (vendorSpaceId: string, userId: string, data: CreateVendorServiceDto) => Prisma.Prisma__VendorServiceClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    updateService: (id: string, userId: string, data: UpdateVendorServiceDto) => Prisma.Prisma__VendorServiceClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    archiveService: (id: string, userId: string) => Prisma.Prisma__VendorServiceClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    reactivateService: (id: string, userId: string) => Prisma.Prisma__VendorServiceClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    findAllProducts: (vendorServiceId: string, includeArchived?: boolean) => Promise<(Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: Prisma.Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    })[]>;
    findProductById: (id: string, includeArchived?: boolean) => Promise<(Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: Prisma.Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }) | null>;
    createProduct: (vendorServiceId: string, userId: string, data: CreateProductDto) => Promise<Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: Prisma.Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }>;
    updateProduct: (id: string, userId: string, data: UpdateProductDto) => Promise<Omit<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: Prisma.Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, "price"> & {
        price: number | null;
    }>;
    archiveProduct: (id: string, userId: string) => Prisma.Prisma__ProductClient<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: Prisma.Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    reactivateProduct: (id: string, userId: string) => Prisma.Prisma__ProductClient<{
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        price: Prisma.Decimal | null;
        currency: string;
        isAvailable: boolean;
        vendorServiceId: string;
        imageUrls: string[];
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=vendor.repository.d.ts.map