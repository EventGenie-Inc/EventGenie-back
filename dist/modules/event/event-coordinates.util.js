import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
const isPlausibleLatitude = (value) => Number.isFinite(value) && value >= -90 && value <= 90;
const isPlausibleLongitude = (value) => Number.isFinite(value) && value >= -180 && value <= 180;
// Coordinates are optional on an Event — an organiser may type an address
// that doesn't resolve, or skip search entirely, and the event still
// saves. But a HALF-set pair is worse than none: it won't error anywhere,
// it will just silently produce wrong distances wherever proximity search
// reads it later. So the rule is strictly both-or-neither, checked on
// every create/update path (direct POST, PUT, and the wizard's
// materialize path in event-draft.service.ts).
export const assertValidCoordinates = (latitude, longitude) => {
    const hasLatitude = latitude !== undefined && latitude !== null;
    const hasLongitude = longitude !== undefined && longitude !== null;
    if (!hasLatitude && !hasLongitude)
        return;
    if (hasLatitude !== hasLongitude) {
        throw new HttpError(400, 'Both latitude and longitude must be provided together, or neither — a single coordinate cannot be saved on its own.');
    }
    if (!isPlausibleLatitude(latitude)) {
        throw new HttpError(400, `'${latitude}' is not a valid latitude — it must be a number between -90 and 90.`);
    }
    if (!isPlausibleLongitude(longitude)) {
        throw new HttpError(400, `'${longitude}' is not a valid longitude — it must be a number between -180 and 180.`);
    }
};
// One row — an EventDay (which carries its own venue coordinates since the
// venue moved to the day) or anything else with the same two columns.
export const withPlainDayCoordinates = (row) => ({
    ...row,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
});
// An Event row, and its eventDays when they were included — the day venue
// columns are Decimal too, and every event response that carries days
// would otherwise leak them as strings exactly as described above.
export const withPlainCoordinates = (event) => {
    const days = event.eventDays;
    return {
        ...withPlainDayCoordinates(event),
        ...(days ? { eventDays: days.map(withPlainDayCoordinates) } : {}),
    };
};
//# sourceMappingURL=event-coordinates.util.js.map