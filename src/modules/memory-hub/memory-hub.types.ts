export interface CreateMemoryHubDto {
  title?: string;
  description?: string;
  opensAt?: string;
}

export interface UpdateMemoryHubDto {
  title?: string;
  description?: string;
  opensAt?: string | null;
}

// Organiser upload — authenticated, tenant-scoped. mediaUrl/cloudinaryPublicId/
// bytes come from the browser's own Cloudinary upload response, exactly
// like Event's coverImageUrl/coverImagePublicId/coverImageBytes.
export interface CreateMemoryItemDto {
  mediaUrl: string;
  cloudinaryPublicId: string;
  mediaType: 'IMAGE' | 'VIDEO';
  bytes: number;
  caption?: string;
}

// Guest upload — authenticated by invite token only, as the RSVP
// endpoints are. Same shape as CreateMemoryItemDto plus the token.
export interface CreateGuestMemoryItemDto extends CreateMemoryItemDto {
  token: string;
}

export interface UpdateMemoryItemDto {
  caption?: string;
}

// Curation is its own action, not a field on UpdateMemoryItemDto — same
// "exactly one writer" reasoning as Event.status (event.repository.ts's
// updateStatus): a status transition must never be smuggled through a
// plain caption edit.
export interface CurateMemoryItemDto {
  status: 'APPROVED' | 'REJECTED';
}
