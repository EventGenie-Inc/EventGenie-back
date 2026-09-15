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
export interface CreateMemoryItemDto {
    mediaUrl: string;
    cloudinaryPublicId: string;
    mediaType: 'IMAGE' | 'VIDEO';
    bytes: number;
    caption?: string;
}
export interface CreateGuestMemoryItemDto extends CreateMemoryItemDto {
    token: string;
}
export interface UpdateMemoryItemDto {
    caption?: string;
}
export interface CurateMemoryItemDto {
    status: 'APPROVED' | 'REJECTED';
}
//# sourceMappingURL=memory-hub.types.d.ts.map