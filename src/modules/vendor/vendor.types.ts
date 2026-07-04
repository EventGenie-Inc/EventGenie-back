import { type VendorCategory, type VendorRole } from '@prisma/client';

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

// ── Vendor User ───────────────────────────

export interface CreateVendorUserDto {
  firebaseUid: string;
  email: string;
  name: string;
  role?: VendorRole;
}

export interface UpdateVendorUserDto {
  name?: string;
  role?: VendorRole;
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