export interface CreateEventDayDto {
    label: string;
    date: string;
    startTime?: string;
    endTime?: string;
    location: string;
    address: string;
    latitude?: number | null;
    longitude?: number | null;
}
export interface UpdateEventDayDto {
    label?: string;
    date?: string;
    startTime?: string | null;
    endTime?: string | null;
    location?: string;
    address?: string;
    latitude?: number | null;
    longitude?: number | null;
}
//# sourceMappingURL=event-day.types.d.ts.map