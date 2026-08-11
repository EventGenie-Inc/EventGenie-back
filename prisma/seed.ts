// ============================================================
//  EventGenie — Seed Script
//  Run from project root with: npx tsx prisma/seed.ts
//
//  Creates:
//  1. SuperAdmin user (platform owner)
//  2. Subscription tier configurations (SPARK, CELEBRATE, ELEVATE)
//
//  Safe to run multiple times — skips existing records.
// ============================================================

import { getAuth } from 'firebase-admin/auth';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import dotenv from 'dotenv';

dotenv.config();

// ─────────────────────────────────────────
//  Import the shared Prisma singleton
//  This ensures the Neon adapter is
//  correctly initialised — Prisma 7 requires
//  the adapter to be passed to the constructor.
// ─────────────────────────────────────────
import prisma from '../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  Initialise Firebase Admin
// ─────────────────────────────────────────
const initFirebase = () => {
  if (getApps().length > 0) return getApps()[0]!;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Missing Firebase Admin credentials in .env. ' +
        'Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are set.'
    );
  }

  return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
};

// ─────────────────────────────────────────
//  Seed SuperAdmin
// ─────────────────────────────────────────
const seedSuperAdmin = async () => {
  const email = 'mashware24@gmail.com';

  console.log('\n── SuperAdmin ────────────────────────────');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`✔  SuperAdmin already exists — skipping (${email})`);
    return existing;
  }

  console.log(`   Looking up Firebase UID for ${email}...`);
  const app = initFirebase();
  const firebaseUser = await getAuth(app).getUserByEmail(email);
  console.log(`✔  Firebase UID found: ${firebaseUser.uid}`);

  const superAdmin = await prisma.user.create({
    data: {
      firebaseUid: firebaseUser.uid,
      email,
      username: 'MashWare',
      role: 'SUPER_ADMIN',
      tenantId: null,
      isActive: true,
      isArchived: false,
    },
  });

  console.log(`✔  SuperAdmin created`);
  console.log(`   ID:    ${superAdmin.id}`);
  console.log(`   Email: ${superAdmin.email}`);
  console.log(`   Role:  ${superAdmin.role}`);

  return superAdmin;
};

// ─────────────────────────────────────────
//  Seed Subscription Tier Configs
// ─────────────────────────────────────────
const seedSubscriptionTiers = async () => {
  console.log('\n── Subscription Tiers ────────────────────');

  const tiers = [
    {
      tier: 'SPARK' as const,
      maxEvents: 1,
      maxGuestsPerEvent: 50,
      maxSmsPerMonth: null,
      emailEnabled: true,
      smsEnabled: false,
      vendorMarketplace: false,
      memoryHubEnabled: false,
      dragDropBuilder: false,
    },
    {
      tier: 'CELEBRATE' as const,
      maxEvents: 5,
      maxGuestsPerEvent: 300,
      maxSmsPerMonth: 100,
      emailEnabled: true,
      smsEnabled: true,
      vendorMarketplace: true,
      memoryHubEnabled: true,
      dragDropBuilder: false,
    },
    {
      tier: 'ELEVATE' as const,
      maxEvents: null,
      maxGuestsPerEvent: null,
      maxSmsPerMonth: null,
      emailEnabled: true,
      smsEnabled: true,
      vendorMarketplace: true,
      memoryHubEnabled: true,
      dragDropBuilder: true,
    },
  ];

  for (const tierData of tiers) {
    const existing = await prisma.subscriptionTierConfig.findUnique({
      where: { tier: tierData.tier },
    });

    if (existing) {
      console.log(`✔  ${tierData.tier} tier already exists — skipping`);
      continue;
    }

    await prisma.subscriptionTierConfig.create({ data: tierData });
    console.log(`✔  ${tierData.tier} tier created`);
  }
};

// ─────────────────────────────────────────
//  Run
// ─────────────────────────────────────────
const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║       EventGenie Seed Script         ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await seedSuperAdmin();
    await seedSubscriptionTiers();
    console.log('\n✔  Seed complete\n');
  } catch (error) {
    console.error('\n✘  Seed failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

void main();