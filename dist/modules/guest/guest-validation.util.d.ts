import { type CountryCode } from 'libphonenumber-js';
export declare const normalizeEmail: (raw: string) => string;
export declare const assertValidEmail: (raw: string) => void;
export type ContactShape = 'email' | 'phone' | 'unknown';
export declare const detectContactShape: (raw: string) => ContactShape;
export declare const normalizePhoneToE164: (raw: string, defaultCountry?: CountryCode) => string;
export declare const assertExactlyOneContact: (email: string | null, phoneNumber: string | null) => void;
export interface ExistingContact {
    guestId: string;
    email: string | null;
    phoneNumber: string | null;
}
export declare const findDuplicateContact: (existing: ExistingContact[], candidate: {
    email: string | null;
    phoneNumber: string | null;
}) => {
    guestId: string;
} | null;
//# sourceMappingURL=guest-validation.util.d.ts.map