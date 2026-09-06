import { type DeliveryMethod } from '@prisma/client';
import { type ExistingContact } from './guest-validation.util.js';
export interface ParsedImportRow {
    rowNumber: number;
    firstNameRaw: string;
    surnameRaw: string;
    contactRaw: string;
    dayRaw: string;
}
export declare const parseImportFile: (buffer: Buffer, originalFilename: string, mimeType: string) => Promise<ParsedImportRow[]>;
export interface EventDayOption {
    id: string;
    label: string;
}
export interface ValidatedGuestRow {
    rowNumber: number;
    firstName: string | null;
    surname: string | null;
    email: string | null;
    phoneNumber: string | null;
    deliveryMethod: DeliveryMethod;
    eventDayIds: string[];
}
export interface ImportRowFailure {
    row: number;
    contact: string;
    reason: string;
}
export interface ImportEngineResult {
    totalRows: number;
    validRows: ValidatedGuestRow[];
    failures: ImportRowFailure[];
}
export declare const validateImportRows: (rows: ParsedImportRow[], eventDays: EventDayOption[], existingContacts: ExistingContact[]) => ImportEngineResult;
//# sourceMappingURL=guest-import.engine.d.ts.map