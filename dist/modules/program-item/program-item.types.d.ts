export interface CreateProgramItemDto {
    title: string;
    description?: string;
    startTime: string;
    durationMins?: number;
    order: number;
    eventDayId?: string | null;
}
export interface UpdateProgramItemDto {
    title?: string;
    description?: string;
    startTime?: string;
    durationMins?: number;
    order?: number;
    eventDayId?: string | null;
}
//# sourceMappingURL=program-item.types.d.ts.map