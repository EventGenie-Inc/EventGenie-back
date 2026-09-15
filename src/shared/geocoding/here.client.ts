import { type AddressSuggestion, type ResolvedAddress, type StructuredAddress } from './here.types.js';

// ─────────────────────────────────────────
//  HERE CLIENT
//
//  Knows HERE Geocoding & Search v7 and nothing else — no Event,
//  Tenant, or tier concepts. Same separation as sms.engine.ts /
//  email.engine.ts. Throws plain Error on any failure (missing key,
//  timeout, non-2xx, malformed response); geocoding.service.ts is
//  responsible for turning that into an HttpError the frontend can
//  show without ever blocking event creation.
// ─────────────────────────────────────────

const AUTOSUGGEST_URL = 'https://autosuggest.search.hereapi.com/v1/autosuggest';
const LOOKUP_URL = 'https://lookup.search.hereapi.com/v1/lookup';
const REQUEST_TIMEOUT_MS = 6000;

// Johannesburg — South Africa's largest metro by population. HERE requires
// either `at` or `in` on autosuggest; `in=countryCode:ZAF` below does the
// real narrowing to South Africa, so this is only a ranking nudge toward
// the country's biggest concentration of addresses when a query is
// otherwise ambiguous (e.g. a street name that recurs in several towns).
const DEFAULT_AT = '-26.2041,28.0473';

interface HereAddressBlock {
  label?: string;
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

interface HereAutosuggestItem {
  id: string;
  title: string;
  resultType: string;
  address?: HereAddressBlock;
}

interface HereAutosuggestResponse {
  items?: HereAutosuggestItem[];
}

interface HereLookupResponse {
  title: string;
  id: string;
  address?: HereAddressBlock;
  position?: { lat: number; lng: number };
}

const fetchWithTimeout = async (url: URL): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const requireApiKey = (): string => {
  const apiKey = process.env.HERE_API_KEY;
  if (!apiKey) throw new Error('HERE_API_KEY is not defined in .env');
  return apiKey;
};

const toStructuredAddress = (address?: HereAddressBlock): StructuredAddress => ({
  ...(address?.countryCode !== undefined && { countryCode: address.countryCode }),
  ...(address?.countryName !== undefined && { countryName: address.countryName }),
  ...(address?.state !== undefined && { state: address.state }),
  ...(address?.county !== undefined && { county: address.county }),
  ...(address?.city !== undefined && { city: address.city }),
  ...(address?.district !== undefined && { district: address.district }),
  ...(address?.street !== undefined && { street: address.street }),
  ...(address?.postalCode !== undefined && { postalCode: address.postalCode }),
  ...(address?.houseNumber !== undefined && { houseNumber: address.houseNumber }),
});

export const hereAutosuggest = async (query: string): Promise<AddressSuggestion[]> => {
  const apiKey = requireApiKey();

  const url = new URL(AUTOSUGGEST_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('at', DEFAULT_AT);
  url.searchParams.set('in', 'countryCode:ZAF');
  url.searchParams.set('apiKey', apiKey);

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`HERE autosuggest request failed with status ${res.status}`);
  }

  const body = await res.json() as HereAutosuggestResponse;

  // Autosuggest returns two item shapes: an actual address/place
  // (has `address`) and a category/chain query suggestion (e.g. "restaurants
  // near me") whose `id` HERE's own docs say is NOT resolvable via Lookup.
  // Filtered out here so every id this function returns is guaranteed to
  // work with hereLookup below.
  return (body.items ?? [])
    .filter((item) => item.address !== undefined)
    .map((item) => ({
      id: item.id,
      title: item.title,
      label: item.address?.label ?? item.title,
    }));
};

export const hereLookup = async (id: string): Promise<ResolvedAddress> => {
  const apiKey = requireApiKey();

  const url = new URL(LOOKUP_URL);
  url.searchParams.set('id', id);
  url.searchParams.set('apiKey', apiKey);

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`HERE lookup request failed with status ${res.status}`);
  }

  const body = await res.json() as HereLookupResponse;

  if (!body.position) {
    throw new Error('HERE lookup response did not include a resolvable position');
  }

  return {
    label: body.address?.label ?? body.title,
    latitude: body.position.lat,
    longitude: body.position.lng,
    address: toStructuredAddress(body.address),
  };
};
