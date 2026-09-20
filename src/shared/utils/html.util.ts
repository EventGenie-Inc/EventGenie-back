// Escapes text for interpolation into an HTML email body. Organiser-typed
// values (event name, venue) reach guests' inboxes, so any message builder
// that puts them in markup should pass them through here.
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
