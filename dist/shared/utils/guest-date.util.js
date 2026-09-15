// Shared guest-facing date format — a guest has no account, no context,
// and reads this in error/status messages (RSVP deadlines, invite
// expiry, Memory Hub opening dates). Kept in one place so every message
// a guest sees uses the same style. Originally invite-dispatch.service.ts's
// earliestDayLabel; promoted here once a second module (Memory Hub) needed
// the identical formatting.
export const formatGuestDate = (date) => date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
//# sourceMappingURL=guest-date.util.js.map