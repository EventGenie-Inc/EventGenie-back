export interface CreateMemoryHubDto {
  title?: string;
  description?: string;
  opensAt?: string;
}

export interface UpdateMemoryHubDto {
  title?: string;
  description?: string;
  isPublic?: boolean;
  opensAt?: string | null;
}

export interface CreateMemoryItemDto {
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