import dotenv from 'dotenv';
dotenv.config();

// ═══════════════════════════════════════════════════════════
//  FLAGS
//
//  --reset-tier-configs   Overwrite the three SubscriptionTierConfig rows
//                         with the values in TIER_CONFIGS below, replacing
//                         anything a SUPER_ADMIN has edited. Without it the
//                         seed only ever CREATES a missing tier config and
//                         leaves an existing one untouched.
//
//  --reset-tenants        Same, for the seed tenants (TENANTS below): put
//                         name, email, subscriptionTier and
//                         subscriptionStatus back to the seed values.
//                         Without it an existing tenant is left alone — a
//                         tenant deliberately moved to Celebrate for a test
//                         stays there.
//
//  --reset-users          Same, for the seed accounts (ACCOUNTS below):
//                         put email, username, role, tenantId, isActive and
//                         isArchived back to the seed values. Without it an
//                         existing user is left alone.
//
//  Each is separate on purpose: restoring a tenant's tier should not also
//  demote a user, or vice versa.
//
//  Parsed before the safety guards and strict on purpose: a mistyped flag
//  that was silently ignored would leave someone believing a reset had
//  happened when it had not.
// ═══════════════════════════════════════════════════════════

const KNOWN_FLAGS = ['--reset-tier-configs', '--reset-tenants', '--reset-users'];
const unknownFlags = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.includes(arg));
if (unknownFlags.length) {
  console.error(`✖ Unknown argument(s): ${unknownFlags.join(', ')}. Known: ${KNOWN_FLAGS.join(', ')}.`);
  process.exit(1);
}
const RESET_TIER_CONFIGS = process.argv.includes('--reset-tier-configs');
const RESET_TENANTS = process.argv.includes('--reset-tenants');
const RESET_USERS = process.argv.includes('--reset-users');

// ═══════════════════════════════════════════════════════════
//  SAFETY GUARDS
//
//  This script creates real Firebase Auth users and real
//  database rows. It must be impossible to run accidentally
//  against production.
//
//  The shared Prisma client and Firebase Admin SDK are loaded
//  via dynamic import() ONLY after these guards pass — not just
//  called later, but not even *evaluated* until then. This means
//  no database adapter and no Firebase app are constructed at
//  all if any guard fails, not merely "no queries are run".
// ═══════════════════════════════════════════════════════════

const DEV_DB_MARKER = 'eventgenie_dev';

// Mirrors src/shared/prisma/prisma.client.ts's own URL resolution
// exactly, so this guard checks the same URL the shared client
// will actually connect through — not a different one.
const resolveDatabaseUrl = (): string => {
  const env = process.env.NODE_ENV ?? 'development';
  const varName = env === 'production' ? 'DATABASE_URL_PROD' : 'DATABASE_URL_DEV';
  const url = process.env[varName];
  if (!url) {
    console.error(`✖ ${varName} is not defined in .env — refusing to run.`);
    process.exit(1);
  }
  return url;
};

const assertSafeToRun = (): { host: string; database: string } => {
  // Guard 1 — hard refuse in production, regardless of anything else.
  if (process.env.NODE_ENV === 'production') {
    console.error('✖ Refusing to run: NODE_ENV is "production". This seed script must never touch production.');
    process.exit(1);
  }

  // Guard 2 — the resolved URL itself must name the dev database.
  // This does NOT rely on NODE_ENV being set correctly — even with
  // NODE_ENV unset/misconfigured, a DATABASE_URL_DEV that doesn't
  // point at the dev database is refused.
  const dbUrl = resolveDatabaseUrl();

  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    console.error('✖ Could not parse the resolved database URL — refusing to run.');
    process.exit(1);
  }

  const database = parsed.pathname.replace(/^\//, '');

  if (!dbUrl.includes(DEV_DB_MARKER)) {
    console.error(
      `✖ Refusing to run: resolved database URL does not contain "${DEV_DB_MARKER}" ` +
      `(host="${parsed.hostname}", database="${database}"). This does not look like the dev database.`
    );
    process.exit(1);
  }

  // Guard 3 — print exactly what's about to be written to, before any work happens.
  console.log('═══════════════════════════════════════════');
  console.log('  EventGenie Dev Seed');
  console.log('═══════════════════════════════════════════');
  console.log(`  About to seed:`);
  console.log(`    Host:     ${parsed.hostname}`);
  console.log(`    Database: ${database}`);
  console.log('═══════════════════════════════════════════\n');

  return { host: parsed.hostname, database };
};

assertSafeToRun();

// ═══════════════════════════════════════════════════════════
//  SEED DATA
// ═══════════════════════════════════════════════════════════

const SEED_TEST_PASSWORD = process.env.SEED_TEST_PASSWORD ?? 'EventGenieDev#2026';

// ── ADDING A TIER COLUMN? THE MIGRATION NEEDS A PER-TIER UPDATE. ─────────
// `null` on a numeric limit means UNLIMITED (see STEERING.md "Tier
// enforcement"). A migration that only does ADD COLUMN therefore leaves every
// existing row unlimited — it fails OPEN. This file cannot fix that for you:
// the seed never runs against a database it isn't pointed at, and it no
// longer overwrites existing tier configs. maxVendorSpaces and
// maxMemoryHubBytesPerEvent were both added exactly that way: correct here,
// but on any database the seed never touched they are null, i.e. unlimited.
// So the migration itself must also carry, per tier, something like:
//   UPDATE "SubscriptionTierConfig" SET "newLimit" = <value> WHERE "tier" = 'CELEBRATE';
// and this array must be updated to match. To push new seed values onto an
// existing dev database afterwards, use --reset-tier-configs.
const TIER_CONFIGS = [
  {
    tier: 'SPARK' as const,
    maxEvents: 1,
    maxGuestsPerEvent: 50,
    maxSmsPerMonth: null,
    // Unreachable in practice — vendorMarketplace:false below blocks SPARK
    // from the marketplace entirely, before this count is ever checked.
    // Set explicitly (0) rather than left null/unlimited, for clarity.
    maxVendorSpaces: 0,
    // Unreachable too — memoryHubEnabled:false below blocks SPARK from
    // Memory Hub entirely, before this is ever checked.
    maxMemoryHubBytesPerEvent: 0,
    emailEnabled: true,
    smsEnabled: false,
    vendorMarketplace: false,
    memoryHubEnabled: false,
    dragDropBuilder: false,
    guestExportEnabled: false,
    isAvailable: true,
  },
  {
    tier: 'CELEBRATE' as const,
    maxEvents: 5,
    maxGuestsPerEvent: 300,
    maxSmsPerMonth: 100,
    maxVendorSpaces: 2,
    // 500MB per event — generous for a real gallery of phone photos plus
    // a handful of short video clips (see upload-constants.ts for the
    // per-file reasoning), while keeping storage cost per event bounded
    // on the mid tier. ELEVATE is unlimited below.
    maxMemoryHubBytesPerEvent: 500 * 1024 * 1024,
    emailEnabled: true,
    smsEnabled: true,
    vendorMarketplace: true,
    memoryHubEnabled: true,
    dragDropBuilder: false,
    guestExportEnabled: true,
    isAvailable: true,
  },
  {
    tier: 'ELEVATE' as const,
    maxEvents: null,
    maxGuestsPerEvent: null,
    maxSmsPerMonth: null,
    maxVendorSpaces: null,
    maxMemoryHubBytesPerEvent: null,
    emailEnabled: true,
    smsEnabled: true,
    vendorMarketplace: true,
    memoryHubEnabled: true,
    dragDropBuilder: true,
    guestExportEnabled: true,
    isAvailable: true,
  },
];

const TENANTS = {
  testEventsCo: {
    name: 'Test Events Co',
    slug: 'test-events-co',
    email: 'test-events-co@eventgenie.test',
    subscriptionTier: 'CELEBRATE' as const,
  },
  sparkTenant: {
    name: 'Spark Tenant',
    slug: 'spark-tenant',
    email: 'spark-tenant@eventgenie.test',
    subscriptionTier: 'SPARK' as const,
  },
};

interface SeedAccount {
  email: string;
  username: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'EVENT_ADMIN';
  tenantSlug: keyof typeof TENANTS | null;
}

const ACCOUNTS: SeedAccount[] = [
  { email: 'superadmin@eventgenie.test', username: 'Super Admin', role: 'SUPER_ADMIN', tenantSlug: null },
  { email: 'tenantadmin@eventgenie.test', username: 'Tenant Admin', role: 'TENANT_ADMIN', tenantSlug: 'testEventsCo' },
  { email: 'eventadmin@eventgenie.test', username: 'Event Admin', role: 'EVENT_ADMIN', tenantSlug: 'testEventsCo' },
  { email: 'sparkadmin@eventgenie.test', username: 'Spark Admin', role: 'TENANT_ADMIN', tenantSlug: 'sparkTenant' },
];

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════

// Field-by-field "key: old → new" for every seed value the existing row does
// not already hold — so a reset is never silent and a leftover difference is
// always visible. Shared by the tier configs, tenants and users.
const differencesFrom = (existing: object, seed: Record<string, unknown>): string[] =>
  Object.keys(seed)
    .filter((key) => (existing as Record<string, unknown>)[key] !== seed[key])
    .map((key) => `${key}: ${JSON.stringify((existing as Record<string, unknown>)[key])} → ${JSON.stringify(seed[key])}`);

async function main() {
  // Loaded here, after the guards above have already passed —
  // this is the earliest point any DB/Firebase client exists.
  const { default: prisma } = await import('../src/shared/prisma/prisma.client.js');
  const { firebaseAdmin } = await import('../src/shared/firebase/firebase.admin.js');
  const { getAuth } = await import('firebase-admin/auth');

  const auth = getAuth(firebaseAdmin);

  try {
    // ── SubscriptionTierConfig ──────────────────────────────
    // Create when absent, leave alone when present — a SUPER_ADMIN's edits
    // through the UI must survive a re-seed. A tier config is live pricing
    // policy, not fixture data. See --reset-tier-configs above for the one
    // deliberate way to overwrite, e.g. to populate a column added since.
    console.log('── Subscription Tier Configs ──');
    for (const config of TIER_CONFIGS) {
      const existing = await prisma.subscriptionTierConfig.findUnique({ where: { tier: config.tier } });

      if (!existing) {
        await prisma.subscriptionTierConfig.create({ data: config });
        console.log(`  ✔ created ${config.tier}`);
        continue;
      }

      const differences = differencesFrom(existing, config);

      if (RESET_TIER_CONFIGS) {
        await prisma.subscriptionTierConfig.update({ where: { tier: config.tier }, data: config });
        console.log(
          differences.length
            ? `  ↻ reset ${config.tier} — ${differences.join('; ')}`
            : `  ↻ reset ${config.tier} — already matched the seed values`
        );
      } else if (differences.length) {
        console.log(`  ↷ already exists ${config.tier} — differs from the seed values, left as is (${differences.join('; ')})`);
      } else {
        console.log(`  ↷ already exists ${config.tier}`);
      }
    }
    if (!RESET_TIER_CONFIGS) {
      console.log('  (existing tier configs are never modified — pass --reset-tier-configs to overwrite them with the seed values)');
    }

    // ── Tenants ──────────────────────────────────────────────
    // Create when absent, leave alone when present — same rule as the tier
    // configs above. This used to be an upsert whose update branch reset
    // name, email, subscriptionTier and subscriptionStatus on every run, so
    // a tenant put on Celebrate (or SUSPENDED) for a test quietly went back
    // to its seed values the next time anyone seeded. See --reset-tenants.
    console.log('\n── Tenants ──');
    type TenantRow = NonNullable<Awaited<ReturnType<typeof prisma.tenant.findUnique>>>;
    const tenantRows = {} as Record<keyof typeof TENANTS, TenantRow>;
    for (const key of Object.keys(TENANTS) as (keyof typeof TENANTS)[]) {
      const t = TENANTS[key];
      const seedValues = {
        name: t.name,
        email: t.email,
        subscriptionTier: t.subscriptionTier,
        subscriptionStatus: 'ACTIVE' as const,
      };
      const existing = await prisma.tenant.findUnique({ where: { slug: t.slug } });

      if (!existing) {
        tenantRows[key] = await prisma.tenant.create({
          data: { ...seedValues, slug: t.slug, isArchived: false },
        });
        console.log(`  ✔ created "${t.name}" (${t.slug}) — ${tenantRows[key].id}`);
        continue;
      }

      const differences = differencesFrom(existing, seedValues);
      if (RESET_TENANTS) {
        tenantRows[key] = await prisma.tenant.update({ where: { slug: t.slug }, data: seedValues });
        console.log(
          differences.length
            ? `  ↻ reset "${t.name}" (${t.slug}) — ${differences.join('; ')}`
            : `  ↻ reset "${t.name}" (${t.slug}) — already matched the seed values`
        );
      } else {
        tenantRows[key] = existing;
        console.log(
          differences.length
            ? `  ↷ already exists "${t.name}" (${t.slug}) — differs from the seed values, left as is (${differences.join('; ')})`
            : `  ↷ already exists "${t.name}" (${t.slug}) — ${existing.id}`
        );
      }
    }
    if (!RESET_TENANTS) {
      console.log('  (existing tenants are never modified — pass --reset-tenants to overwrite them with the seed values)');
    }

    // ── Firebase Auth users + matching Postgres User rows ────
    console.log('\n── Test Accounts ──');
    for (const account of ACCOUNTS) {
      const tenantId = account.tenantSlug ? tenantRows[account.tenantSlug].id : null;

      let firebaseUser;
      let firebaseStatus: string;
      try {
        firebaseUser = await auth.getUserByEmail(account.email);
        firebaseStatus = 'firebase: already exists';
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'auth/user-not-found') throw err;
        firebaseUser = await auth.createUser({
          email: account.email,
          password: SEED_TEST_PASSWORD,
          displayName: account.username,
          emailVerified: true,
        });
        firebaseStatus = 'firebase: created';
      }

      const seedValues = {
        email: account.email,
        username: account.username,
        role: account.role,
        tenantId,
        isActive: true,
        isArchived: false,
      };
      const existingUser = await prisma.user.findUnique({ where: { firebaseUid: firebaseUser.uid } });

      // Create when absent, leave alone when present — this used to be an
      // upsert whose update branch reset email, username, role, tenantId,
      // isActive and isArchived on every run, silently demoting a user whose
      // role was changed, re-activating one who was deactivated, and
      // un-archiving one who was archived. See --reset-users.
      let userNote: string;
      if (!existingUser) {
        await prisma.user.create({ data: { firebaseUid: firebaseUser.uid, ...seedValues } });
        userNote = 'postgres: created';
      } else {
        const differences = differencesFrom(existingUser, seedValues);
        if (RESET_USERS) {
          await prisma.user.update({ where: { firebaseUid: firebaseUser.uid }, data: seedValues });
          userNote = differences.length
            ? `postgres: ↻ reset — ${differences.join('; ')}`
            : 'postgres: ↻ reset — already matched the seed values';
        } else {
          userNote = differences.length
            ? `postgres: already exists — differs from the seed values, left as is (${differences.join('; ')})`
            : 'postgres: already exists';
        }
      }

      console.log(`  ${account.email} — ${firebaseStatus}, ${userNote} (${account.role})`);
    }
    if (!RESET_USERS) {
      console.log('  (existing users are never modified — pass --reset-users to overwrite them with the seed values)');
    }

    // ── Sample event under "Test Events Co" ──────────────────
    console.log('\n── Sample Event ──');
    const eventName = 'EventGenie Sample Launch Party';
    const testEventsCoTenant = tenantRows.testEventsCo;
    const tenantAdminUser = await prisma.user.findUnique({ where: { email: 'tenantadmin@eventgenie.test' } });
    if (!tenantAdminUser) throw new Error('tenantadmin@eventgenie.test was not seeded — cannot attach sample event');

    const existingEvent = await prisma.event.findFirst({
      where: { tenantId: testEventsCoTenant.id, name: eventName },
    });

    if (existingEvent) {
      console.log(`  ↷ already exists — "${eventName}" (${existingEvent.id})`);
    } else {
      const now = Date.now();
      const dayOneDate = new Date(now + 30 * 24 * 60 * 60 * 1000);
      const dayTwoDate = new Date(now + 31 * 24 * 60 * 60 * 1000);

      const atTime = (base: Date, hours: number, minutes = 0): Date => {
        const d = new Date(base);
        d.setHours(hours, minutes, 0, 0);
        return d;
      };

      const dayOneStart = atTime(dayOneDate, 10);
      const dayOneEnd = atTime(dayOneDate, 18);
      const dayTwoStart = atTime(dayTwoDate, 10);
      const dayTwoEnd = atTime(dayTwoDate, 16);

      const actor = tenantAdminUser.id;

      const event = await prisma.$transaction(async (tx) => {
        const created = await tx.event.create({
          data: {
            tenantId: testEventsCoTenant.id,
            createdByUserId: actor,
            name: eventName,
            description: 'A sample event seeded for manual and automated testing.',
            location: 'Cape Town, South Africa',
            status: 'PUBLISHED',
            visibility: 'PRIVATE',
            ticketing: 'FREE',
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        await tx.eventDay.create({
          data: {
            eventId: created.id,
            label: 'Day One',
            date: dayOneDate,
            startTime: dayOneStart,
            endTime: dayOneEnd,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });
        await tx.eventDay.create({
          data: {
            eventId: created.id,
            label: 'Day Two',
            date: dayTwoDate,
            startTime: dayTwoStart,
            endTime: dayTwoEnd,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        await tx.rsvpField.create({
          data: {
            eventId: created.id,
            label: 'Dietary Requirements',
            fieldType: 'TEXT',
            isRequired: false,
            options: null,
            order: 0,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });
        await tx.rsvpField.create({
          data: {
            eventId: created.id,
            label: 'T-Shirt Size',
            fieldType: 'DROPDOWN',
            isRequired: false,
            options: JSON.stringify(['S', 'M', 'L', 'XL']),
            order: 1,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        const program = await tx.eventProgram.create({
          data: {
            eventId: created.id,
            title: 'Event Day Schedule',
            isPublished: true,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });
        await tx.programItem.create({
          data: {
            programId: program.id,
            title: 'Welcome & Registration',
            description: 'Guests arrive and check in.',
            startTime: dayOneStart,
            durationMins: 30,
            order: 0,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });
        await tx.programItem.create({
          data: {
            programId: program.id,
            title: 'Opening Address',
            description: 'Welcome remarks from the organizers.',
            startTime: atTime(dayOneDate, 10, 30),
            durationMins: 20,
            order: 1,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        await tx.memoryHub.create({
          data: {
            eventId: created.id,
            title: null,
            description: null,
            isPublic: false,
            shareToken: null,
            opensAt: null,
            isArchived: false,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        return created;
      });

      console.log(`  ✔ created "${eventName}" (${event.id}) with 2 days, 2 RSVP fields, a 2-item program, and a memory hub`);
    }

    // ── Summary ────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════');
    console.log('  Seed complete — test accounts');
    console.log('═══════════════════════════════════════════');
    console.log(`  Shared password for all accounts: ${SEED_TEST_PASSWORD}\n`);
    console.log('  Email                              Role          Tenant');
    console.log('  ─────────────────────────────────  ────────────  ────────────────');
    for (const account of ACCOUNTS) {
      const tenantName = account.tenantSlug ? TENANTS[account.tenantSlug].name : '(none)';
      console.log(`  ${account.email.padEnd(35)} ${account.role.padEnd(13)} ${tenantName}`);
    }
    console.log('═══════════════════════════════════════════\n');
  } finally {
    const { default: prisma } = await import('../src/shared/prisma/prisma.client.js');
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✖ Seed failed:', err);
  process.exit(1);
});
