# EventGenie

Multi-tenant SaaS event management platform, built by MashWare.

EventGenie gives event organisers — from families planning a wedding to
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
| Dev | `dev.eventgenie.org.za` | `dev.api.eventgenie.org.za` | Firebase Hosting / Render |
| Prod | `app.eventgenie.org.za` | `prod.api.eventgenie.org.za` | Firebase Hosting / Render |

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
| `superadmin@eventgenie.test` | SUPER_ADMIN | — |
| `tenantadmin@eventgenie.test` | TENANT_ADMIN | Test Events Co (Celebrate) |
| `eventadmin@eventgenie.test` | EVENT_ADMIN | Test Events Co (Celebrate) |
| `sparkadmin@eventgenie.test` | TENANT_ADMIN | Spark Tenant (Spark) |

Two tenants exist deliberately: it makes cross-tenant isolation and
tier-gating testable without inventing fixtures.

Emails at `@eventgenie.test` cannot receive mail. To complete the OTP flow
locally, read the code from the `OtpRecord` table in the dev database.

The seed script refuses to run unless `NODE_ENV !== 'production'` **and**
the resolved database URL contains `eventgenie_dev`.

---

## Environment variables

```
PORT, NODE_ENV
DATABASE_URL_DEV, DATABASE_URL_DEV_DIRECT
DATABASE_URL_PROD, DATABASE_URL_PROD_DIRECT
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
