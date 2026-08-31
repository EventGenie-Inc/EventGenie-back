import dotenv from 'dotenv';
dotenv.config();

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
    emailEnabled: true,
    smsEnabled: false,
    vendorMarketplace: false,
    memoryHubEnabled: false,
    dragDropBuilder: false,
    isAvailable: true,
  },
  {
    tier: 'CELEBRATE' as const,
    maxEvents: 5,
    maxGuestsPerEvent: 300,
    maxSmsPerMonth: 100,
    maxVendorSpaces: 2,
    emailEnabled: true,
    smsEnabled: true,
    vendorMarketplace: true,
    memoryHubEnabled: true,
    dragDropBuilder: false,
    isAvailable: true,
  },
  {
    tier: 'ELEVATE' as const,
    maxEvents: null,
    maxGuestsPerEvent: null,
    maxSmsPerMonth: null,
    maxVendorSpaces: null,
    emailEnabled: true,
    smsEnabled: true,
    vendorMarketplace: true,
    memoryHubEnabled: true,
    dragDropBuilder: true,
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

async function main() {
  // Loaded here, after the guards above have already passed —
  // this is the earliest point any DB/Firebase client exists.
  const { default: prisma } = await import('../src/shared/prisma/prisma.client.js');
  const { firebaseAdmin } = await import('../src/shared/firebase/firebase.admin.js');
  const { getAuth } = await import('firebase-admin/auth');

  const auth = getAuth(firebaseAdmin);

  try {
    // ── SubscriptionTierConfig ──────────────────────────────
    console.log('── Subscription Tier Configs ──');
    for (const config of TIER_CONFIGS) {
      const existing = await prisma.subscriptionTierConfig.findUnique({ where: { tier: config.tier } });
      await prisma.subscriptionTierConfig.upsert({
        where: { tier: config.tier },
        create: config,
        update: config,
      });
      console.log(`  ${existing ? '↷ updated' : '✔ created'} ${config.tier}`);
    }

    // ── Tenants ──────────────────────────────────────────────
    console.log('\n── Tenants ──');
    type TenantRow = Awaited<ReturnType<typeof prisma.tenant.upsert>>;
    const tenantRows = {} as Record<keyof typeof TENANTS, TenantRow>;
    for (const key of Object.keys(TENANTS) as (keyof typeof TENANTS)[]) {
      const t = TENANTS[key];
      const existing = await prisma.tenant.findUnique({ where: { slug: t.slug } });
      const tenant = await prisma.tenant.upsert({
        where: { slug: t.slug },
        create: {
          name: t.name,
          slug: t.slug,
          email: t.email,
          subscriptionTier: t.subscriptionTier,
          subscriptionStatus: 'ACTIVE',
          isArchived: false,
        },
        update: {
          name: t.name,
          email: t.email,
          subscriptionTier: t.subscriptionTier,
          subscriptionStatus: 'ACTIVE',
        },
      });
      tenantRows[key] = tenant;
      console.log(`  ${existing ? '↷ already exists' : '✔ created'} "${t.name}" (${t.slug}) — ${tenant.id}`);
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

      const existingUser = await prisma.user.findUnique({ where: { firebaseUid: firebaseUser.uid } });
      await prisma.user.upsert({
        where: { firebaseUid: firebaseUser.uid },
        create: {
          firebaseUid: firebaseUser.uid,
          email: account.email,
          username: account.username,
          role: account.role,
          tenantId,
          isActive: true,
          isArchived: false,
        },
        update: {
          email: account.email,
          username: account.username,
          role: account.role,
          tenantId,
          isActive: true,
          isArchived: false,
        },
      });

      console.log(
        `  ${account.email} — ${firebaseStatus}, postgres: ${existingUser ? 'already exists' : 'created'} (${account.role})`
      );
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
