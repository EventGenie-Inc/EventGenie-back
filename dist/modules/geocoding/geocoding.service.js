import { hereAutosuggest, hereLookup } from '../../shared/geocoding/here.client.js';
import {} from '../../shared/geocoding/here.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
// ─────────────────────────────────────────
//  GEOCODING SERVICE
//
//  Thin proxy over here.client.ts. Two jobs beyond the raw HERE call:
//
//  1. Never let a HERE outage/slowdown surface as anything but a clear,
//     specific error — event creation itself never calls HERE at all
//     (see event.service.ts), so a failure here only affects the address
//     search dropdown; the address field stays usable as plain text.
//  2. Cache autosuggest results briefly — the same venue names get
//     searched repeatedly by the same tenant, and every call costs
//     against HERE's monthly quota. No Redis: a plain in-memory Map is
//     enough for a single-instance deployment (same caveat as
//     rate-limit.middleware.ts — per-instance only if ever scaled out).
// ─────────────────────────────────────────
const MIN_QUERY_LENGTH = 3;
const SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SUGGESTION_CACHE_MAX_ENTRIES = 500;
const suggestionCache = new Map();
const getCached = (key) => {
    const entry = suggestionCache.get(key);
    if (!entry)
        return undefined;
    if (Date.now() > entry.expiresAt) {
        suggestionCache.delete(key);
        return undefined;
    }
    // Re-insert to mark as most-recently-used (Map preserves insertion order).
    suggestionCache.delete(key);
    suggestionCache.set(key, entry);
    return entry.items;
};
const setCached = (key, items) => {
    if (suggestionCache.size >= SUGGESTION_CACHE_MAX_ENTRIES) {
        const oldestKey = suggestionCache.keys().next().value;
        if (oldestKey !== undefined)
            suggestionCache.delete(oldestKey);
    }
    suggestionCache.set(key, { items, expiresAt: Date.now() + SUGGESTION_CACHE_TTL_MS });
};
const asUnavailableError = (error) => {
    console.error('[HERE geocoding]', error instanceof Error ? error.message : error);
    throw new HttpError(502, 'Address search is temporarily unavailable. You can keep typing the address by hand — it will still save.');
};
export const geocodingService = {
    autosuggest: async (rawQuery) => {
        const query = rawQuery.trim();
        if (query.length < MIN_QUERY_LENGTH) {
            throw new HttpError(400, `Enter at least ${MIN_QUERY_LENGTH} characters to search for an address`);
        }
        const cacheKey = query.toLowerCase();
        const cached = getCached(cacheKey);
        if (cached)
            return cached;
        let items;
        try {
            items = await hereAutosuggest(query);
        }
        catch (error) {
            return asUnavailableError(error);
        }
        setCached(cacheKey, items);
        return items;
    },
    lookup: async (rawId) => {
        const id = rawId.trim();
        if (!id) {
            throw new HttpError(400, 'A HERE place id is required');
        }
        try {
            return await hereLookup(id);
        }
        catch (error) {
            return asUnavailableError(error);
        }
    },
};
//# sourceMappingURL=geocoding.service.js.map