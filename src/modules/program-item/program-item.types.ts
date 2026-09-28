export interface CreateProgramItemDto {
  title: string;
  description?: string;
  startTime: string;
  durationMins?: number;
  order: number;
  // Which EventDay this item applies to. Omitted/null means "applies to
  // every day" — see STEERING.md. Must belong to the same event as the
  // program itself (422 if not) — checked in program-item.service.ts.
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
