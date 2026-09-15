export interface AddressSuggestion {
    id: string;
    title: string;
    label: string;
}
export interface StructuredAddress {
    countryCode?: string;
    countryName?: string;
    state?: string;
    county?: string;
    city?: string;
    district?: string;
    street?: string;
    postalCode?: string;
    houseNumber?: string;
}
export interface ResolvedAddress {
    label: string;
    latitude: number;
    longitude: number;
    address: StructuredAddress;
}
//# sourceMappingURL=here.types.d.ts.map