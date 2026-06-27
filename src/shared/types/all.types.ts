// ================================================================
//  EVENT DAY
// ================================================================

// event-day.types.ts
export interface CreateEventDayDto {
  eventId: string;
  label: string;
  date: string;
  startTime?: string;
  endTime?: string;
}
export interface UpdateEventDayDto {
  label?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
}

// ================================================================
//  GUEST
// ================================================================

export interface CreateGuestDto {
  firstName: string;
  surname: string;
  email?: string;
  phoneNumber?: string;
}
export interface UpdateGuestDto {
  firstName?: string;
  surname?: string;
  email?: string;
  phoneNumber?: string;
}

// ================================================================
//  INVITE
// ================================================================

export interface CreateInviteDto {
  eventId: string;
  guestId: string;
  deliveryMethod: 'EMAIL' | 'SMS';
  expiresAt?: string;
  invitedDayIds: string[];
}
export interface UpdateInviteDto {
  status?: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  deliveryMethod?: 'EMAIL' | 'SMS';
  expiresAt?: string;
}

// ================================================================
//  INVITE EVENT DAY
// ================================================================

export interface CreateInviteEventDayDto {
  inviteId: string;
  eventDayId: string;
}

// ================================================================
//  ATTENDANCE
// ================================================================

export interface CreateAttendanceDto {
  inviteId: string;
  eventDayId: string;
}

// ================================================================
//  MEMORY HUB
// ================================================================

export interface CreateMemoryHubDto {
  eventId: string;
  title?: string;
  description?: string;
}
export interface UpdateMemoryHubDto {
  title?: string;
  description?: string;
  isPublic?: boolean;
}

// ================================================================
//  MEMORY ITEM
// ================================================================

export interface CreateMemoryItemDto {
  memoryHubId: string;
  mediaUrl: string;
  mediaType: 'IMAGE' | 'VIDEO';
  caption?: string;
  uploadedByGuestId?: string;
  uploadedByUserId?: string;
}
export interface UpdateMemoryItemDto {
  caption?: string;
  isApproved?: boolean;
}

// ================================================================
//  VENDOR SPACE
// ================================================================

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

// ================================================================
//  VENDOR USER
// ================================================================

export interface CreateVendorUserDto {
  vendorSpaceId: string;
  firebaseUid: string;
  email: string;
  name: string;
  role?: 'VENDOR_OWNER' | 'VENDOR_STAFF';
}
export interface UpdateVendorUserDto {
  name?: string;
  role?: 'VENDOR_OWNER' | 'VENDOR_STAFF';
}

// ================================================================
//  VENDOR SERVICE
// ================================================================

export interface CreateVendorServiceDto {
  vendorSpaceId: string;
  name: string;
  category: 'CATERING' | 'DECOR' | 'FURNITURE' | 'PHOTOGRAPHY' | 'ENTERTAINMENT' | 'FLORISTRY' | 'OTHER';
  description?: string;
  operatingDays?: string;
  operatingHours?: string;
}
export interface UpdateVendorServiceDto {
  name?: string;
  category?: 'CATERING' | 'DECOR' | 'FURNITURE' | 'PHOTOGRAPHY' | 'ENTERTAINMENT' | 'FLORISTRY' | 'OTHER';
  description?: string;
  operatingDays?: string;
  operatingHours?: string;
}

// ================================================================
//  PRODUCT
// ================================================================

export interface CreateProductDto {
  vendorServiceId: string;
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

// ================================================================
//  SUBSCRIPTION TIER CONFIG
// ================================================================

export interface CreateSubscriptionTierConfigDto {
  tier: 'SPARK' | 'CELEBRATE' | 'ELEVATE';
  maxEvents?: number;
  maxGuestsPerEvent?: number;
  maxSmsPerMonth?: number;
  emailEnabled: boolean;
  smsEnabled: boolean;
  vendorMarketplace: boolean;
  memoryHubEnabled: boolean;
  dragDropBuilder: boolean;
}
export interface UpdateSubscriptionTierConfigDto {
  maxEvents?: number;
  maxGuestsPerEvent?: number;
  maxSmsPerMonth?: number;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  vendorMarketplace?: boolean;
  memoryHubEnabled?: boolean;
  dragDropBuilder?: boolean;
}