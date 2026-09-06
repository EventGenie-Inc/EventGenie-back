import { HttpError } from '../../shared/errors/http-error.js';
// Event.capacity is the VENUE's physical capacity — a fact about the
// room, not a billing constraint. It must never be conflated with
// SubscriptionTierConfig.maxGuestsPerEvent (enforced separately in
// guest-tier-enforcement.util.ts, which still blocks). Capacity itself
// never blocks anything — it only informs, via acceptedGuestCount on the
// event detail response — so this only validates the number is sane.
export const assertValidCapacity = (capacity) => {
    if (capacity === undefined || capacity === null)
        return;
    if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new HttpError(400, `'${capacity}' is not a valid capacity — it must be a positive whole number.`);
    }
};
//# sourceMappingURL=event-capacity.util.js.map