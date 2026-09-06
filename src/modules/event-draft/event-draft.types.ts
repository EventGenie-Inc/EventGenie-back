export interface UpsertEventDraftDto {
  currentStep: number;
  payload: Record<string, unknown>;
}
