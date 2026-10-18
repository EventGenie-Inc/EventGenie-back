export interface CreateEventProgramDto {
  title?: string;
}

export interface UpdateEventProgramDto {
  title?: string | null;
  isPublished?: boolean;
}
