import dotenv from 'dotenv';
dotenv.config();

// ═══════════════════════════════════════════════════════════
//  ONE-TIME SETUP — create the four Paystack Plans this
//  environment's subscription billing runs on, and print the
//  environment variables to set from the result.
//
//  Run manually, once per Paystack environment (test mode now;
//  live mode again whenever production is switched on — a test-mode
//  plan code and a live-mode plan code are different Paystack objects
//  even for the "same" plan). NOT run automatically on deploy and NOT
//  called by the running application — see
//  subscription-plans.config.ts's own comment for why plan codes are
//  referenced from configuration rather than created on first use.
//
//  Safe to re-run: it checks for an existing plan with the same
//  name before creating one, so accidentally running it twice does not
//  mint duplicate plans.
//
//    npx tsx prisma/create-subscription-plans.ts
// ═══════════════════════════════════════════════════════════

import { SUBSCRIPTION_PRICES_CENTS } from '../src/modules/subscription/subscription-plans.config.js';

interface PlanToCreate {
  envVar: string;
  name: string;
  amountCents: number;
  interval: 'monthly' | 'annually';
}

const PLANS: PlanToCreate[] = [
  { envVar: 'PAYSTACK_PLAN_CELEBRATE_MONTHLY', name: 'EventGenie Celebrate — Monthly', amountCents: SUBSCRIPTION_PRICES_CENTS.CELEBRATE.MONTHLY, interval: 'monthly' },
  { envVar: 'PAYSTACK_PLAN_CELEBRATE_ANNUAL', name: 'EventGenie Celebrate — Annual', amountCents: SUBSCRIPTION_PRICES_CENTS.CELEBRATE.ANNUAL, interval: 'annually' },
  { envVar: 'PAYSTACK_PLAN_ELEVATE_MONTHLY', name: 'EventGenie Elevate — Monthly', amountCents: SUBSCRIPTION_PRICES_CENTS.ELEVATE.MONTHLY, interval: 'monthly' },
  { envVar: 'PAYSTACK_PLAN_ELEVATE_ANNUAL', name: 'EventGenie Elevate — Annual', amountCents: SUBSCRIPTION_PRICES_CENTS.ELEVATE.ANNUAL, interval: 'annually' },
];

const main = async (): Promise<void> => {
  const { listPlans, createPlan } = await import('../src/shared/payments/paystack.client.js');

  const existing = await listPlans();
  const results: { envVar: string; planCode: string }[] = [];

  for (const plan of PLANS) {
    const already = existing.find((p) => p.name === plan.name);
    if (already) {
      console.log(`already exists: "${plan.name}" -> ${already.planCode}`);
      results.push({ envVar: plan.envVar, planCode: already.planCode });
      continue;
    }

    const created = await createPlan({
      name: plan.name,
      amountCents: plan.amountCents,
      interval: plan.interval,
      currency: 'ZAR',
    });
    console.log(`created: "${plan.name}" -> ${created.planCode}`);
    results.push({ envVar: plan.envVar, planCode: created.planCode });
  }

  console.log('\nAdd these to .env (and to Render for each environment):\n');
  for (const r of results) {
    console.log(`${r.envVar}=${r.planCode}`);
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✘ Failed to create subscription plans:', err);
    process.exit(1);
  });
