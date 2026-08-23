# EventGenie Backend

Node.js + Express + TypeScript, Prisma 7, PostgreSQL on Neon, Firebase Admin SDK.

## Dev Seed Script

`prisma/seed.ts` populates the **dev** database with a known-good set of
test data so authenticated flows can actually be exercised — manually or
by an agent session — without first having to hand-create tenants, users,
and an event.

### What it creates

- **Subscription tier configs** for `SPARK`, `CELEBRATE`, `ELEVATE` (limits
  and feature flags, matching the current schema).
- **Two tenants** — `Test Events Co` (CELEBRATE tier) and `Spark Tenant`
  (SPARK tier). Two tenants exist deliberately: it makes cross-tenant
  isolation manually verifiable, and lets SPARK-vs-CELEBRATE tier-gating
  be compared side by side.
- **Four test accounts** — real Firebase Auth users (email/password) with
  matching Postgres `User` rows. See the credentials table below.
- **One sample event** under `Test Events Co` — published, private, free
  (no tickets — ticketing has no payment integration yet, so seeded
  tickets would be misleading), with two event days, two custom RSVP
  fields (one text, one dropdown), a two-item program, and a memory hub.

It does **not** seed vendors, guests, invites, or tickets — those flows
are either unbuilt or unintegrated, and seeding them would create
misleading test data.

### Running it

```
npm run seed
```

The script is **idempotent** — running it repeatedly finds existing rows
by their natural unique key (tenant slug, user's Firebase UID, event
name within a tenant) and skips or upserts rather than duplicating.

### Safety guards

This script creates real Firebase Auth users and real database rows, so
it is built to make an accidental run against production effectively
impossible:

1. **Hard exit if `NODE_ENV === 'production'`.**
2. **Hard exit if the resolved database URL doesn't contain
   `eventgenie_dev`** — checked independently of `NODE_ENV`, so an
   unset or misconfigured `NODE_ENV` can't be enough on its own to let
   it run against prod.
3. **Prints the exact database host and name it's about to write to**
   before doing any work, so a human running it can abort if it looks
   wrong.

The Prisma client and Firebase Admin SDK are only loaded (via dynamic
`import()`) *after* these guards pass — nothing that could construct a
database or Firebase connection exists at all until the checks succeed.

### Test accounts

All accounts share one password, read from `SEED_TEST_PASSWORD` (falls
back to a dev default if unset) and printed at the end of every run.

| Email | Role | Tenant |
|---|---|---|
| `superadmin@eventgenie.test` | `SUPER_ADMIN` | (none) |
| `tenantadmin@eventgenie.test` | `TENANT_ADMIN` | Test Events Co (CELEBRATE) |
| `eventadmin@eventgenie.test` | `EVENT_ADMIN` | Test Events Co (CELEBRATE) |
| `sparkadmin@eventgenie.test` | `TENANT_ADMIN` | Spark Tenant (SPARK) |

These are throwaway dev-only accounts on a dev-only database — the
password is intentionally shared and printed to console, not treated as
a secret.
