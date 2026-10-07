import 'dotenv/config';
import prisma from '../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  EMAIL COLLISION REPORT — read-only
//
//  Lists the rows the lowercase-email migrations leave un-normalised
//  because lowercasing and trimming their email would collide with another
//  row:
//    - User (20261006091000_lowercase_emails): two users whose emails
//      differ only by case or surrounding whitespace (User.email is unique
//      platform-wide).
//    - Guest (same migration): two guests on the SAME event in that
//      position.
//    - Tenant (20261007090000_lowercase_tenant_emails): two tenants in that
//      position (Tenant.email is unique). The Paystack subscription lookup
//      matches neither until it's resolved.
//  Run it BEFORE applying the migration to see what it will skip, and after
//  to confirm what was skipped. It never writes. Resolve each group by hand
//  (suspend or re-email a user; archive or merge a guest; change one
//  tenant's billing email), then the next
//  deploy's writes keep everything normalised.
//
//  Uses the app's own Prisma client, so it reads whichever database NODE_ENV
//  selects (NODE_ENV=test → the test database, behind its isolation guard).
//  Prints ids, roles and emails; no tokens or other secrets.
//
//    npx tsx scripts/report-email-collisions.ts
// ─────────────────────────────────────────

const NORM = `lower(regexp_replace("email", '^\\s+|\\s+$', '', 'g'))`;

const users = await prisma.$queryRawUnsafe<{ norm: string; id: string; email: string; tenantId: string | null; role: string }[]>(`
  WITH n AS (SELECT "id", "email", "tenantId", "role"::text AS "role", ${NORM} AS "norm" FROM "User")
  SELECT * FROM n WHERE "norm" IN (SELECT "norm" FROM n GROUP BY "norm" HAVING count(*) > 1)
  ORDER BY "norm", "id"
`);

const guests = await prisma.$queryRawUnsafe<{ eventId: string; norm: string; id: string; email: string; isArchived: boolean }[]>(`
  WITH n AS (SELECT "id", "eventId", "email", "isArchived", ${NORM} AS "norm" FROM "Guest" WHERE "email" IS NOT NULL)
  SELECT n.* FROM n
  JOIN (SELECT "eventId", "norm" FROM n GROUP BY "eventId", "norm" HAVING count(*) > 1) c
    ON c."eventId" = n."eventId" AND c."norm" = n."norm"
  ORDER BY n."eventId", n."norm", n."id"
`);

const tenants = await prisma.$queryRawUnsafe<{ norm: string; id: string; email: string; name: string; slug: string }[]>(`
  WITH n AS (SELECT "id", "email", "name", "slug", ${NORM} AS "norm" FROM "Tenant")
  SELECT * FROM n WHERE "norm" IN (SELECT "norm" FROM n GROUP BY "norm" HAVING count(*) > 1)
  ORDER BY "norm", "id"
`);

console.log(`User collisions: ${users.length} row(s)`);
for (const u of users) console.log(`  [${u.norm}] user ${u.id} role=${u.role} tenant=${u.tenantId ?? '-'} email=${JSON.stringify(u.email)}`);
console.log(`Guest collisions (same event): ${guests.length} row(s)`);
for (const g of guests) console.log(`  [event ${g.eventId} · ${g.norm}] guest ${g.id}${g.isArchived ? ' (archived)' : ''} email=${JSON.stringify(g.email)}`);

console.log(`Tenant collisions: ${tenants.length} row(s)`);
for (const t of tenants) console.log(`  [${t.norm}] tenant ${t.id} slug=${t.slug} name=${JSON.stringify(t.name)} email=${JSON.stringify(t.email)}`);

await prisma.$disconnect();
