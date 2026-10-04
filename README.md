# e-velope

Multi-tenant SaaS event management platform, built by MashWare.

e-velope gives event organisers — from families planning a wedding to
promoters running a concert series — the tools to invite guests, collect
RSVPs, sell tickets, discover vendors, and preserve memories, in one
platform instead of a stack of disconnected tools.

---

## Repositories

| Repo | Purpose | Stack |
|---|---|---|
| `EventGenie-back` | REST API | Node.js, Express, TypeScript, Prisma 7, PostgreSQL (Neon) |
| `eventgenie-front-1` | Web client | Angular, TypeScript |

---

## Environments

| | Frontend | API | Hosting |
|---|---|---|---|
| Dev | `dev.e-velope.co.za` | `dev.api.e-velope.co.za` | Firebase Hosting / Render |
| Prod | `https://www.e-velope.co.za` | `prod.api.e-velope.co.za` | Firebase Hosting / Render |

The prod frontend is `https://www.e-velope.co.za`. `e-velope.co.za`,
`evelope.co.za` and `www.evelope.co.za` all redirect to it, so it is the
one prod origin `ALLOWED_ORIGINS` and `FRONTEND_BASE_URL` need.

Branch mapping: `develop` → dev, `main` → prod. Render auto-deploys from
branch; the frontend deploys via CI to its matching Firebase Hosting site.

---

## Third-party services

| Service | Used for |
|---|---|
| Firebase Authentication | User identity (first auth factor) |
| Resend | Transactional email — OTP, password reset, invitations |
| Twilio | SMS invitations (South African number, local rates) |
| Cloudinary | Photo and video storage for the Memory Hub |
| Neon | Managed PostgreSQL |

---

## Core concepts

**Tenant** — an organiser's isolated workspace. Created by self-service
registration, never by an admin. All data is scoped to a tenant.

**Roles** — `SUPER_ADMIN` (platform owner, seeded manually, no tenant),
`TENANT_ADMIN` (workspace owner), `EVENT_ADMIN` (team member),
`EVENT_VENDOR` (vendor space manager).

**Event visibility** — `PRIVATE` events have an organiser-built guest list
and individual tokenised invitations. `PUBLIC` events have a shareable
link; guests self-create by RSVPing. These are genuinely different
workflows, not a toggle on one workflow.

**Event status** — `DRAFT` → `PUBLISHED` via an explicit publish action.
`COMPLETED` is **derived at read time** from the last event day passing,
never stored. `CANCELLED` is stored and irreversible. Nothing reaches a
guest until an event is published.

**Subscription tiers** — Spark (free), Celebrate (R299/mo), Elevate
(R999/mo). Limits live in the `SubscriptionTierConfig` table and are read
at runtime, never hardcoded.

**Soft delete** — nothing is hard-deleted. Records carry `isArchived` and
every archive action has a working restore path. Two exceptions, both
deliberate: `Attendance` (a fact record) and `EventDraft` (transient
wizard state).

---

## Authentication

Two factors, both required on every protected request:

1. **Firebase ID token** — `Authorization: Bearer <token>`
2. **Session JWT** — `X-Session-Token: <token>`, issued after email OTP
   verification, 15-minute lifetime with silent refresh

Session tokens are held in memory. With "keep me signed in" checked they
also persist to `sessionStorage`, surviving a page refresh but not a tab
close. `localStorage` is never used for session tokens.

---

## The four-page guest experience

A guest opening an invitation sees one tab-navigated experience:

1. **Invitation Card** — branded, template-based
2. **RSVP Form** — canonical fields plus the organiser's custom fields,
   and ticket selection for paid events
3. **Digital Program** — optional, shown only if the organiser built one
4. **Memory Hub** — opens on a configured date, tier-gated

---

## Local setup

**Backend**

```bash
cd EventGenie-back
npm install
cp .env.example .env      # populate — see Environment variables below
npx prisma migrate dev
npm run seed              # dev-only, creates test accounts
npm run dev
```

**Frontend**

```bash
cd eventgenie-front
npm install
npm start                 # http://localhost:4200
```

### Test accounts

`npm run seed` creates four accounts across two tenants. Password comes
from `SEED_TEST_PASSWORD` (printed at the end of every seed run).

| Account | Role | Tenant |
|---|---|---|
| `superadmin@evelope.test` | SUPER_ADMIN | — |
| `tenantadmin@evelope.test` | TENANT_ADMIN | Test Events Co (Celebrate) |
| `eventadmin@evelope.test` | EVENT_ADMIN | Test Events Co (Celebrate) |
| `sparkadmin@evelope.test` | TENANT_ADMIN | Spark Tenant (Spark) |

Two tenants exist deliberately: it makes cross-tenant isolation and
tier-gating testable without inventing fixtures.

Emails at `@evelope.test` cannot receive mail. To complete the OTP flow
locally, read the code from the `OtpRecord` table in the dev database.

The seed script refuses to run unless `NODE_ENV !== 'production'` **and**
the resolved database URL contains `evelope-dev`.

**Tier configs are created, never overwritten.** Re-running the seed leaves
an existing `SubscriptionTierConfig` alone, so limits a SUPER_ADMIN has
edited survive. If a row differs from the seed values the run says so. To
deliberately overwrite all three with the values in `prisma/seed.ts` — for
example after adding a tier column that existing rows need populated:

```bash
npm run seed -- --reset-tier-configs
```

Each field it changes is printed as `old → new`.

**Tenants and users follow the same rule.** The seed creates the two seed
tenants and four accounts when they are missing and otherwise leaves them
alone — so a tenant you moved to Celebrate for a test, or a user whose role
you changed, stays that way across re-seeds. A row that differs from the
seed values is reported (`differs from the seed values, left as is (…)`).
Reset them on purpose, separately:

```bash
npm run seed -- --reset-tenants   # name, email, subscriptionTier, subscriptionStatus
npm run seed -- --reset-users     # email, username, role, tenantId, isActive, isArchived
```

An unrecognised flag is refused before anything is touched.

---

## Testing

An automated Vitest suite covers the auth guarantees (Trusted Devices —
`/exchange-session`, `/logout`, revocation, suspension): HTTP-level tests
via `supertest` against the real Express app (`src/app.ts`), with
`firebase-admin/auth`'s `verifyIdToken` stubbed (the one boundary — see
`tests/setup.ts`) so the suite makes no real Firebase calls. Everything
else — Postgres, the real service/repository code — is real.

```bash
npm test           # runs once (vitest run)
npm run test:watch # re-runs on change
```

**Needs its own database — never the shared dev database.** Dev and
prod currently point at one Neon endpoint (`DATABASE_URL` /
`DATABASE_URL_DEV` are the same database), so an automated suite must
never be able to fall back onto it. Set `DATABASE_URL_TEST` in `.env` to
a separate database — a Neon branch works with zero code changes, since
it reuses the same `@prisma/adapter-neon` connection path
`DATABASE_URL_DEV` already does. `src/shared/prisma/prisma.client.ts`
and `prisma.config.ts` **refuse to run** (throw, before any query) if
`DATABASE_URL_TEST` is unset or resolves to the same database as
`DATABASE_URL`/`DATABASE_URL_DEV`/`DATABASE_URL_PROD` (in either their
pooled or direct form — see `database-url-guard.util.ts`: a pooled and a
direct connection string for the SAME Neon database look different as
raw strings but are compared by their normalised Neon endpoint id, so
neither form can slip past the other) — the same "refuse rather than
silently fall back" shape as the seed script's own dev-database check
above. `tests/auth/db-guard.test.ts` tests that refusal itself,
including the pooled-vs-direct case specifically, not just that the
code exists.

Prepare the test database (drop everything, reapply every migration —
needed once, and again after any new migration lands, and safe to
re-run any time):

```bash
npm run test:db:reset
```

This runs the SAME isolation guard explicitly, in
`scripts/reset-test-database.ts`, **before** ever invoking `prisma
migrate reset --force` — not relying solely on `prisma.config.ts`'s own
check — because a reset pointed at the wrong URL doesn't just misbehave,
it drops every table. If `DATABASE_URL_TEST` is a schema-only branch
(tables present, but an empty `_prisma_migrations` table), use this
reset rather than `prisma migrate deploy` — deploy fails when the
tables it's trying to create already exist.

Test fixtures (tenants/users) are created directly via Prisma
(`tests/helpers/db.ts`), not through the real register/OTP HTTP flow —
that flow's own concerns (Firebase sign-up, OTP delivery via Resend) are
Firebase- and Resend-side, and out of scope for a suite that stubs only
`verifyIdToken`. Each test creates uniquely-named fixtures and deletes
them afterward (a **hard** delete — these rows are test fixtures on an
isolated database, not real tenant data, so STEERING.md's soft-delete
rule doesn't apply to them).

---

## Environment variables

```
PORT, NODE_ENV
DATABASE_URL_DEV, DATABASE_URL_DEV_DIRECT
DATABASE_URL_PROD, DATABASE_URL_PROD_DIRECT
DATABASE_URL_TEST
JWT_SECRET, JWT_EXPIRES_IN
FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
RESEND_API_KEY, RESEND_FROM_EMAIL
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
FRONTEND_BASE_URL
ALLOWED_ORIGINS
SEED_TEST_PASSWORD
```

`FRONTEND_BASE_URL` builds password-reset and invitation links. A wrong
value means every sent invitation points somewhere broken — and an SMS
cannot be recalled. Verify it per environment.

`ALLOWED_ORIGINS` is a comma-separated CORS allowlist. Set it on Render
for both services; if unset, `allowedOrigins` resolves empty and every
browser request is rejected.

---

## Build status

Backend and frontend both build clean under strict TypeScript. Automated
test coverage is thin — see `CHANGELOG.md` and the deferred technical
debt register for the honest picture.

---

## Documentation

| File | Contents |
|---|---|
| `README.md` | This file |
| `CHANGELOG.md` | What shipped, when, and what it changed |
| `STEERING.md` | Conventions every contributor and AI agent must follow |
| Deferred Technical Debt Register | Known issues tied to the feature that triggers them |
