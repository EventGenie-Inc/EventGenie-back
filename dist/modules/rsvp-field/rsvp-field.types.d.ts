import { type RsvpFieldType } from '@prisma/client';
export interface CreateRsvpFieldDto {
    label: string;
    fieldType: RsvpFieldType;
    isRequired?: boolean;
    options?: string;
    order: number;
}
export interface UpdateRsvpFieldDto {
    label?: string;
    fieldType?: RsvpFieldType;
    isRequired?: boolean;
    options?: string;
    order?: number;
}
//# sourceMappingURL=rsvp-field.types.d.ts.map