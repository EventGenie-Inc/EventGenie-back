import { type RsvpFieldType } from '@prisma/client';

export interface CreateRsvpFieldDto {
  label: string;
  fieldType: RsvpFieldType;
  isRequired?: boolean;
  options?: string;
  // Help text under the question; resolveFieldDescription's rules.
  description?: string | null;
  order: number;
}

export interface UpdateRsvpFieldDto {
  label?: string;
  fieldType?: RsvpFieldType;
  isRequired?: boolean;
  options?: string | null;
  description?: string | null;
  order?: number;
}
