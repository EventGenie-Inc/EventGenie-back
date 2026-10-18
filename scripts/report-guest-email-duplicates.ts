import 'dotenv/config';
import prisma from '../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  GUEST EMAIL DUPLICATES — read-only
//
//  Lists every email held by more than one LIVE guest on the same event,
//  compared exactly as the unique index in
//  20261009091000_guest_email_unique compares them: lower("email"), guests
//  with isArchived = false. That migration refuses to run while this lists
//  anything. Resolve each group by hand (archive one of the guests, or
//  change one's email), run this again until it lists nothing, then apply
//  the migration.
//
//  It also lists, separately, groups that only match once surrounding
//  whitespace is trimmed too. Those don't block the index (it compares
//  lower(email) only), but the app treats them as the same address
//  (normalizeEmail), so they are worth resolving at the same time. Rows like
//  that are the ones 20261006091000_lowercase_emails had to skip.
//
//  Never writes. Uses the app's own Prisma client, so it reads whichever
//  database NODE_ENV selects (NODE_ENV=test → the test database, behind its
//  isolation guard). Prints ids, names and emails; no tokens.
//
//    npx tsx scripts/report-guest-email-duplicates.ts
// ─────────────────────────────────────────

interface Row {
  eventId: string;
  eventName: string;
  key: string;
  id: string;
  email: string;
  firstName: string | null;
  surname: string | null;
  hostGuestId: string | null;
  selfRegisteredAt: Date | null;
  createdAt: Date;
}

const duplicatesBy = (keyExpr: string) =>
  prisma.$queryRawUnsafe<Row[]>(`
    WITH live AS (
      SELECT g."id", g."eventId", g."email", g."firstName", g."surname", g."hostGuestId",
             g."selfRegisteredAt", g."createdAt", ${keyExpr} AS "key"
      FROM "Guest" g
      WHERE g."isArchived" = false AND g."email" IS NOT NULL
    ),
    groups AS (
      SELECT "eventId", "key" FROM live GROUP BY "eventId", "key" HAVING count(*) > 1
    )
    SELECT live.*, e."name" AS "eventName"
    FROM live
    JOIN groups ON groups."eventId" = live."eventId" AND groups."key" = live."key"
    JOIN "Event" e ON e."id" = live."eventId"
    ORDER BY live."eventId", live."key", live."createdAt"
  `);

const print = (rows: Row[]) => {
  let current = '';
  for (const r of rows) {
    const group = `${r.eventId} ${r.key}`;
    if (group !== current) {
      current = group;
      console.log(`  event ${r.eventId} (${JSON.stringify(r.eventName)}) · ${r.key}`);
    }
    const name = [r.firstName, r.surname].filter(Boolean).join(' ') || '(no name)';
    const marks = [r.hostGuestId ? 'plus-one' : null, r.selfRegisteredAt ? 'self-registered' : null].filter(Boolean).join(', ');
    console.log(
      `    guest ${r.id} ${JSON.stringify(name)} email=${JSON.stringify(r.email)} added ${r.createdAt.toISOString()}${marks ? ` [${marks}]` : ''}`
    );
  }
};

const blocking = await duplicatesBy(`lower("email")`);
const groups = new Set(blocking.map((r) => `${r.eventId} ${r.key}`)).size;
console.log(`Duplicates that block the unique index: ${groups} group(s), ${blocking.length} guest(s)`);
print(blocking);

// A trimmed group is shown whole, unless every guest in it is already
// listed above.
const blockingIds = new Set(blocking.map((r) => r.id));
const trimmedAll = await duplicatesBy(`lower(regexp_replace("email", '^\\s+|\\s+$', '', 'g'))`);
const newGroups = new Set(trimmedAll.filter((r) => !blockingIds.has(r.id)).map((r) => `${r.eventId} ${r.key}`));
const trimmed = trimmedAll.filter((r) => newGroups.has(`${r.eventId} ${r.key}`));
console.log(`Same address once whitespace is trimmed (not blocking): ${newGroups.size} group(s), ${trimmed.length} guest(s)`);
print(trimmed);

await prisma.$disconnect();
