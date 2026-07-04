export interface CreateMemoryHubDto {
  title?: string;
  description?: string;
}

export interface UpdateMemoryHubDto {
  title?: string;
  description?: string;
  isPublic?: boolean;
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