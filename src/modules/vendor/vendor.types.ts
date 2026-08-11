import { type VendorCategory } from '@prisma/client';

// ── Vendor Space ──────────────────────────

export interface CreateVendorSpaceDto {
  name: string;
  description?: string;
  email: string;
  phoneNumber?: string;
  website?: string;
  address?: string;
  latitude: number;
  longitude: number;
  tenantId?: string;
}

export interface UpdateVendorSpaceDto {
  name?: string;
  description?: string;
  email?: string;
  phoneNumber?: string;
  website?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  isVerified?: boolean;
  isActive?: boolean;
}

// ── Vendor Service ────────────────────────

export interface CreateVendorServiceDto {
  name: string;
  category: VendorCategory;
  description?: string;
  operatingDays?: string;
  operatingHours?: string;
}

export interface UpdateVendorServiceDto {
  name?: string;
  category?: VendorCategory;
  description?: string;
  operatingDays?: string;
  operatingHours?: string;
}

// ── Product ───────────────────────────────

export interface CreateProductDto {
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrls?: string[];
}

export interface UpdateProductDto {
  name?: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrls?: string[];
  isAvailable?: boolean;
}