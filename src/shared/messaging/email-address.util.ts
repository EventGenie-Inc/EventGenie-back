// ─────────────────────────────────────────
//  SENDER DISPLAY NAMES
//
//  An invitation's From name carries the organiser's own words ("Thandi &
//  Sipho via e-velope"), and a header is not HTML: escapeHtml does nothing
//  for it. A line break in a header value ends that header and starts
//  another, so organiser text reaches a header only through here:
//    - every control character (CR and LF included), and the Unicode line
//      separators and bidi overrides, becomes a space; runs of whitespace
//      collapse; the result is trimmed and capped in length;
//    - angle brackets are dropped, so a name can't dress itself up as a
//      second address ("Bank <help@bank.example>");
//    - the display name is always sent as an RFC 5322 quoted string, with
//      backslash and double quote escaped inside it.
// ─────────────────────────────────────────

// C0 and C1 controls, DEL, the Unicode line and paragraph separators, and the
// bidi embedding/override/isolate characters (which can reverse how a name
// reads in an inbox).
const UNSAFE_HEADER_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export const MAX_SENDER_NAME_LENGTH = 60;

// Text that may go into any header (a subject, a display name): no line
// breaks or control characters, whitespace collapsed.
export const sanitizeHeaderText = (text: string): string =>
  text.replace(UNSAFE_HEADER_CHARS, ' ').replace(/\s+/g, ' ').trim();

export const sanitizeDisplayName = (name: string, maxLength = MAX_SENDER_NAME_LENGTH): string => {
  const clean = sanitizeHeaderText(name.replace(/[<>]/g, ''));
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}…` : clean;
};

// `"Display Name" <address>`. The address comes from env config, never from
// a user, so it is used as given.
export const formatFromHeader = (displayName: string, address: string): string => {
  const quoted = sanitizeDisplayName(displayName, Number.POSITIVE_INFINITY).replace(/[\\"]/g, (c) => `\\${c}`);
  return `"${quoted}" <${address}>`;
};
