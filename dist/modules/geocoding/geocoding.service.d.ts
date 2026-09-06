import { type AddressSuggestion, type ResolvedAddress } from '../../shared/geocoding/here.types.js';
export declare const geocodingService: {
    autosuggest: (rawQuery: string) => Promise<AddressSuggestion[]>;
    lookup: (rawId: string) => Promise<ResolvedAddress>;
};
//# sourceMappingURL=geocoding.service.d.ts.map