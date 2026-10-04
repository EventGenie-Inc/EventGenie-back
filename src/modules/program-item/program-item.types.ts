export interface CreateProgramItemDto {
  title: string;
  description?: string;
  startTime: string;
  // Whole minutes, 0 or more; null or blank = no duration (422 otherwise).
  durationMins?: number | null;
  // Optional: omitted means "at the end of this program's list"
  // (program-item.service.ts). Used to be required by type only, and a
  // request without it reached Prisma as a generic 500.
  order?: number;
  // Which EventDay this item applies to. Omitted/null means "applies to
  // every day" — see STEERING.md. Must belong to the same event as the
  // program itself (422 if not) — checked in program-item.service.ts.
  eventDayId?: string | null;
}

export interface UpdateProgramItemDto {
  title?: string;
  description?: string;
  startTime?: string;
  durationMins?: number | null;
  order?: number;
  eventDayId?: string | null;
}
