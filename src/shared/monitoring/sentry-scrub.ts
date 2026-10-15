import type { Breadcrumb, Event } from '@sentry/node';

// ─────────────────────────────────────────
//  SENTRY PRIVACY SCRUBBER
//
//  Every event and breadcrumb passes through here on its way out
//  (sentry.config.ts's beforeSend / beforeBreadcrumb). Error data leaves
//  our infrastructure, so it must never carry a credential or a person:
//
//  - request bodies, cookies, query strings and every header outside a
//    short allowlist (Authorization and X-Session-Token included) are
//    dropped, not masked;
//  - URLs lose their query string and fragment, and the path segment
//    that IS a credential (an invite token, a share token) is masked;
//  - anywhere text appears (message, exception text, breadcrumb, extra,
//    tags, contexts), emails, phone numbers, JWTs, bearer values,
//    `key=value` secrets, 64-hex tokens (every token this server mints:
//    invite, share, device, team invite), long base64url strings
//    (Firebase oobCodes) and 6-digit codes (OTPs) are masked;
//  - any object key that names a secret or a contact detail has its
//    value replaced whole;
//  - the user is reduced to id, role and tenantId.
//
//  Allowlists where possible, masking where text is free-form. This file
//  has no Sentry runtime dependency, so tests feed it events directly.
// ─────────────────────────────────────────

export const FILTERED = '[Filtered]';

const MAX_DEPTH = 8;

// Headers worth having on an error and carrying nothing personal.
const HEADER_ALLOWLIST = new Set(['user-agent', 'content-type', 'content-length', 'accept', 'host']);

// The user is reduced to exactly these.
const USER_KEYS = ['id', 'role', 'tenantId'] as const;

// An object key naming a secret or a contact detail: its value goes whole.
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authori[sz]ation|cookie|session|otp|oob_?code|^code$|e-?mail|phone|mobile|msisdn|api[-_]?key|signature|credential/i;

// Path segments that are themselves credentials. Real tokens are 64 hex
// and would be masked by the text rules anyway; these also catch a
// mistyped or truncated one, which is still most of a real token.
// A route pattern's own placeholder (`:token`) names nothing and is kept.
const TOKEN_PATH_RULES: RegExp[] = [
  /(\/rsvp\/validate\/)(?!:)[^/?#\s"']+/gi,
  /(\/ticket-purchase\/confirm\/)(?!:)[^/?#\s"']+/gi,
  /(\/api\/public-events\/)(?!:)[^/?#\s"']+/gi,
  /(\/api\/memory-hub\/)(?!:|guest-view\b|guest-upload-signature\b|guest-items\b)[^/?#\s"']+/gi,
];

const TEXT_RULES: Array<[RegExp, string]> = [
  // A JSON parse error's message quotes the request body itself.
  [/^.*(?:is not valid JSON|in JSON at position|Unexpected token|Unexpected end of JSON).*$/gim, 'Malformed JSON (message withheld: it can quote the request body)'],
  // Absolute URLs: drop query string and fragment.
  [/(\bhttps?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1'],
  // JWTs (session tokens, Firebase ID tokens).
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[token]'],
  // Authorization header values written out.
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${FILTERED}`],
  // key=value / key: value secrets in text (query strings in relative URLs, log lines).
  [
    /\b(token|invite_?token|device_?token|session_?token|oob_?code|code|otp|password|secret|api_?key|key|email|phone(?:_?number)?)(\s*[=:]\s*)(?!\[)("[^"]*"|'[^']*'|[^&\s"',;#)]+)/gi,
    `$1$2${FILTERED}`,
  ],
  // "key":"value" inside JSON-ish text.
  [/"((?:[A-Za-z]*(?:token|password|otp|oobCode|secret|email|phone)[A-Za-z]*)|code)"\s*:\s*"[^"]*"/gi, `"$1":"${FILTERED}"`],
  // Emails.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // 32+ hex: every token this server mints is 64 hex.
  [/\b[a-f0-9]{32,}\b/gi, '[token]'],
  // Long base64url runs (Firebase oobCodes, other opaque credentials).
  // Ids are cuid/uuid (25-36 chars, uuids hyphen-split), so 40 is safe.
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '[token]'],
  // Phone numbers: international (+27…) or local (0…), 9-13 digits, optional single separators.
  [/(?<![\w+])(?:\+\d{1,3}|0)(?:[\s-]?\d){8,12}(?![\w])/g, '[phone]'],
  // Standalone 6-digit codes (sign-in OTPs).
  [/(?<![\w.:/-])\d{6}(?![\w.:/-])/g, '[code]'],
];

const maskTokenPaths = (text: string): string =>
  TOKEN_PATH_RULES.reduce((out, rule) => out.replace(rule, `$1${FILTERED}`), text);

// Masks every credential, contact detail and query string in free text.
export const scrubText = (text: string): string =>
  TEXT_RULES.reduce((out, [rule, replacement]) => out.replace(rule, replacement), maskTokenPaths(text));

// A URL field: query string and fragment dropped, credential path segments masked.
export const scrubUrl = (url: string): string => scrubText(url.replace(/[?#].*$/s, ''));

// Any value: strings masked, sensitive keys replaced whole, nested values walked.
export const scrubValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = FILTERED;
    } else if (/^(url|from|to|referr?er)$/i.test(key) && typeof v === 'string') {
      out[key] = scrubUrl(v);
    } else {
      out[key] = scrubValue(v, depth + 1);
    }
  }
  return out;
};

const scrubRecord = <T>(value: T | undefined): T | undefined =>
  value === undefined ? undefined : (scrubValue(value) as T);

export const scrubBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb => {
  const out: Breadcrumb = { ...breadcrumb };
  if (out.message !== undefined) out.message = scrubText(out.message);
  if (out.data !== undefined) out.data = scrubValue(out.data) as Record<string, unknown>;
  return out;
};

type EventUser = NonNullable<Event['user']>;
type EventRequest = NonNullable<Event['request']>;

const scrubUser = (user: EventUser): EventUser => {
  const out: Record<string, unknown> = {};
  for (const key of USER_KEYS) {
    if (user[key] !== undefined) out[key] = user[key];
  }
  return out as EventUser;
};

const scrubRequest = (request: EventRequest): EventRequest => {
  const out: EventRequest = {};
  if (request.method !== undefined) out.method = request.method;
  if (request.url !== undefined) out.url = scrubUrl(request.url);
  if (request.headers) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (HEADER_ALLOWLIST.has(name.toLowerCase())) headers[name] = scrubText(String(value));
    }
    out.headers = headers;
  }
  // data (the body), cookies, query_string and env are never copied.
  return out;
};

export const scrubEvent = <T extends Event>(event: T): T => {
  const out: T = { ...event };

  if (out.message !== undefined) out.message = scrubText(out.message);
  if (out.logentry) {
    out.logentry = {
      ...out.logentry,
      ...(out.logentry.message !== undefined && { message: scrubText(out.logentry.message) }),
      ...(out.logentry.params !== undefined && { params: scrubValue(out.logentry.params) as unknown[] }),
    };
  }
  if (out.transaction !== undefined) out.transaction = scrubUrl(out.transaction);

  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((ex) => {
        const scrubbed = { ...ex };
        if (scrubbed.value !== undefined) scrubbed.value = scrubText(scrubbed.value);
        if (scrubbed.mechanism?.data) {
          scrubbed.mechanism = { ...scrubbed.mechanism, data: scrubValue(scrubbed.mechanism.data) as typeof scrubbed.mechanism.data };
        }
        if (scrubbed.stacktrace?.frames) {
          scrubbed.stacktrace = {
            ...scrubbed.stacktrace,
            // Local variables can hold anything the function was handling,
            // and source context lines can hold literals (an address).
            frames: scrubbed.stacktrace.frames.map(({ vars: _vars, ...frame }) => ({
              ...frame,
              ...(frame.context_line !== undefined && { context_line: scrubText(frame.context_line) }),
              ...(frame.pre_context !== undefined && { pre_context: frame.pre_context.map(scrubText) }),
              ...(frame.post_context !== undefined && { post_context: frame.post_context.map(scrubText) }),
            })),
          };
        }
        return scrubbed;
      }),
    };
  }

  if (out.sdkProcessingMetadata) {
    // The SDK keeps the raw request (full URL with its token and query
    // string, every header) and the client IP here, for its own
    // integrations. Normally stripped before sending; never relied on.
    const { normalizedRequest: _request, ipAddress: _ip, ...metadata } = out.sdkProcessingMetadata;
    out.sdkProcessingMetadata = metadata;
  }
  if (out.request) out.request = scrubRequest(out.request);
  if (out.user) out.user = scrubUser(out.user);
  if (out.breadcrumbs) out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb);

  const extra = scrubRecord(out.extra);
  if (extra !== undefined) out.extra = extra;
  const tags = scrubRecord(out.tags);
  if (tags !== undefined) out.tags = tags;
  if (out.contexts) {
    // The trace context is the SDK's own ids (32/16 hex), which the hex
    // rule would mask and Sentry would then reject; it carries nothing else.
    const { trace, ...rest } = out.contexts;
    out.contexts = { ...(scrubValue(rest) as NonNullable<Event['contexts']>), ...(trace !== undefined && { trace }) };
  }

  return out;
};
