// ─────────────────────────────────────────
//  DATABASE URL GUARD
//
//  A raw-string comparison between DATABASE_URL_TEST and DATABASE_URL/
//  DATABASE_URL_DEV is not enough: Neon exposes the SAME underlying
//  database through two different hostnames — a pooled one
//  (ep-xxxx-xxxx-pooler.<region>.aws.neon.tech) and a direct one
//  (ep-xxxx-xxxx.<region>.aws.neon.tech, no "-pooler"). DATABASE_URL_DEV
//  and DATABASE_URL_DEV_DIRECT already are exactly this pair for dev.
//  A DATABASE_URL_TEST that's the pooled form of the SAME endpoint as a
//  direct dev URL (or vice versa) would sail past a naive `===` check
//  while still pointing at the identical database — dev and prod share
//  one Neon endpoint today (see prisma.client.ts), so this is the exact
//  mistake that would let an automated test run, or worse a `prisma
//  migrate reset`, wipe production.
//
//  Compares the NORMALISED HOST instead: the connection string's
//  hostname with a trailing "-pooler" stripped from its first label
//  (the Neon endpoint id). localhost/127.0.0.1/::1 are always allowed
//  through unconditionally — a local Postgres can never coincide with a
//  remote Neon host by definition, and this is also how a future local-
//  Postgres DATABASE_URL_TEST setup stays supported without special-
//  casing it elsewhere.
// ─────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export const normalizeDatabaseHost = (connectionString: string): string => {
  const host = new URL(connectionString).hostname.toLowerCase();
  const [firstLabel, ...rest] = host.split('.');
  const normalizedFirstLabel = (firstLabel ?? '').replace(/-pooler$/, '');
  return [normalizedFirstLabel, ...rest].join('.');
};

// Throws if `testUrl` resolves to the same database host as any of
// `others` (entries with an undefined value are skipped — an unset
// DATABASE_URL_PROD in a dev environment, for instance, is not a match
// to guard against). Label the throw with whichever entry matched, so
// the error says WHICH shared variable the collision is with.
export const assertDatabaseUrlIsolated = (
  testUrl: string,
  others: Record<string, string | undefined>
): void => {
  const testHost = normalizeDatabaseHost(testUrl);
  if (LOCAL_HOSTS.has(testHost)) return;

  for (const [label, url] of Object.entries(others)) {
    if (!url) continue;
    if (normalizeDatabaseHost(url) === testHost) {
      throw new Error(
        `DATABASE_URL_TEST resolves to the same database as ${label} ` +
        '(matched by Neon endpoint id after normalising pooled vs. direct hosts). ' +
        'Refusing to run against the shared dev/prod database.'
      );
    }
  }
};
