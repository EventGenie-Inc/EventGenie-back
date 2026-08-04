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
export interface CreateInviteEventDayDto {
    inviteId: string;
    eventDayId: string;
}
export interface CreateAttendanceDto {
    inviteId: string;
    eventDayId: string;
}
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
//# sourceMappingURL=all.types.d.ts.map