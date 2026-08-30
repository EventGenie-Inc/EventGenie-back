// ─────────────────────────────────────────
//  HERE CLIENT RESULT SHAPES
//
//  Shared contract between here.client.ts and any caller (currently
//  geocoding.service.ts) — mirrors messaging.types.ts's role for the
//  SMS/Email engines.
// ─────────────────────────────────────────

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
