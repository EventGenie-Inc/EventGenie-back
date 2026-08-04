export interface CreateProgramItemDto {
    title: string;
    description?: string;
    startTime: string;
    durationMins?: number;
    order: number;
}
export interface UpdateProgramItemDto {
    title?: string;
    description?: string;
    startTime?: string;
    durationMins?: number;
    order?: number;
}
//# sourceMappingURL=program-item.types.d.ts.map