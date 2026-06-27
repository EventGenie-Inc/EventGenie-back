export interface CreateEventDayDto {
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