# EventGenie — Steering

Conventions every contributor and AI coding agent must follow.

> **This file exists in two repos** — `EventGenie-back` (canonical) and the
> frontend repo — and the two copies must be **byte-identical**. Change
> the backend copy first, then copy it over unchanged; never edit only
> one. Check with `diff` or `shasum` on the two files: no difference
> means in sync. A frontend-only agent cannot read the backend repo,
> which is why the copy exists; if you find the two differ, say so
> before relying on either.

**Read this before writing any code.** Task prompts assume it and will
not repeat what is here. Where a prompt contradicts this file, the
prompt wins for that task only — flag the contradiction rather than
silently picking one.

---

## 1. Working principles

**Verify, don't assume.** Route shapes, field names, and response
bodies in a task prompt are written from memory or specification and
have been wrong before. Read the actual code first. Report any mismatch
rather than working around it silently.

**Stay in scope.** Fix what the task asks for. Anything else you find
gets **flagged in the report, not fixed** — unless leaving it would make
the task itself pointless, in which case fix it and say so prominently.

**Report honestly.** State plainly what you could not test and why.
"I could not verify this because X" is always better than a claim that
sounds like verification but is not. Do not soften findings to be
agreeable; do not manufacture findings to seem thorough. "This area is
genuinely fine" is a valid, valuable finding.

**A passing build is not a passing test.** `npm run build` proves types
line up. It proves nothing about behaviour. Test against the real dev
database with real seed accounts.

**Prove your tests bite.** When adding a regression test, temporarily
revert the fix, confirm the test fails, restore it, confirm it passes.
Report both runs. A test that only ever passes proves nothing.

---

## 2. Architecture

### Backend — `EventGenie-back`

```
model → repository → service → router
```

Four files per module, all in `src/modules/<name>/`:

```
<name>.types.ts        DTOs and interfaces
<name>.repository.ts   Prisma queries only, no business logic
<name>.service.ts      Business logic, validation, authorisation
<name>.router.ts       Express routes, auth middleware, req/res only
```

Shared code lives in `src/shared/` — middleware, Prisma client, Firebase
admin, messaging engines, utilities.

**Never** put Prisma calls in a router, or business logic in a
repository.

### Frontend — `eventgenie-front`

```
src/app/core/       auth, http, models, guards — app-wide singletons
src/app/shared/     reusable presentational components
src/app/features/   feature modules (admin, events, auth, public)
```

Modern Angular throughout: `signal()`, `computed()`, `effect()`,
`input()`, `output()`, and the `@if` / `@for` control flow. Not
`@Input()`, `*ngIf`, or `*ngFor`.

Forms use signals with explicit `(input)` handlers, **not** Angular's
Forms API. `@angular/forms` is installed but unused — do not reach for
it without raising it first.

---

## 3. Non-negotiable rules

### Tenant scoping

Every repository method that fetches or mutates a record **by id** must
verify the record belongs to the caller's tenant.

Reference implementation: `src/modules/event/`.

```ts
findById: (id: string, tenantId?: string) =>
  prisma.x.findFirst({
    where: { id, isArchived: false, ...(tenantId ? { tenantId } : {}) },
  })
```

- Optional param, conditional spread — existing internal callers that
  legitimately need unscoped access keep working
- Service threads `tenantId` from the authenticated user
- `SUPER_ADMIN` passes `undefined` to bypass — that is the role's purpose
- Router passes `(auth.user.role, auth.user.tenantId)`

**Transitive scoping.** Entities without their own `tenantId` (event
days, invites, attendance) scope through their parent event by gating on
the already-scoped `eventService.getById()`. See `src/modules/event-day/`.

Cross-tenant access has been found and fixed in this codebase **five
separate times**. Assume it is missing until you have read the code.

### Soft delete

Nothing is hard-deleted. Records carry `isArchived: Boolean @default(false)`.

Five documented exceptions:

- `Attendance` — a guest's **RSVP answer per day** ("will attend"), NOT
  arrival. RSVP submit rebuilds these wholesale on every edit, which is why
  they are hard-deleted rather than archived. Do not record who turned up
  here.
- `CheckIn` — a fact record: this person arrived on this event day, or they
  did not. Undoing a wrong tap is a delete of the row.
- `EventDraft` — transient wizard state, deleted on materialisation.
- `PaymentLedgerEntry` (Payments Foundation) — an append-only money ledger,
  never soft-deleted OR edited: no `isArchived`, no `updatedAt`, and
  deliberately no update/delete method anywhere in
  `payment-ledger.repository.ts`.
- The append-only send logs `SmsSendLog` and `InviteReminderLog` — a message
  was sent, or failed to be, recorded once and never edited or archived.

`EventDraft` is a record that stopped mattering once consumed;
`PaymentLedgerEntry` and the logs record something that happened, which does
not stop having happened. A correction is a NEW entry, never an edit to an old one. What a tenant
has earned, whether a subscription is current, etc. are all summed from
entries at read time — there is no balance column to instead mark
`isArchived` on, and none should be added.

**Every archive needs a working restore.** And restore's own lookup must
**not** filter archived records out:

```ts
// The whole point is to find something that IS archived.
const record = await repo.findById(id, /* includeArchived */ true);
```

This exact bug has shipped **three times** — `user.reactivate`,
`tenant.reactivate`, `invite.reactivate`. Check it every time.

Also: if archiving hides a record from the only list an admin could use
to restore it, the feature is broken even though every method works.

### Errors

Throw `HttpError(status, message)`, never a bare `Error`. The global
handler only maps `HttpError` to a real status code — everything else
becomes a masked 500 and the real reason is lost in production.

| Status | Use for |
|---|---|
| 400 | Malformed input |
| 403 | Authenticated but not permitted, including tier limits |
| 404 | Not found — **also** the correct response for cross-tenant access |
| 409 | State conflict (already published, duplicate) |
| 422 | Valid shape, unsatisfied preconditions |

Messages are read by non-technical organisers. Write
"This event is still a draft. Publish it before sending invitations." —
not "Invalid state transition."

Cross-tenant access returns **404, not 403**. Confirming a record exists
in another tenant is itself a leak.

### Tier enforcement

Subscription limits are enforced **server-side**. Frontend gating is UX,
never the security boundary — for a period the frontend was the only
gate in the system and the API could be called directly to bypass it.

Read limits from `SubscriptionTierConfig` at runtime. Never hardcode
them; a `SUPER_ADMIN` can change them and enforcement must follow.
`null` means unlimited.

Enforcement points differ: `maxGuestsPerEvent` is checked at **import
time**; `maxSmsPerMonth` at **send time**, all-or-nothing.

**A new tier column needs a per-tier `UPDATE` in its migration.** `null` on a
numeric limit means unlimited, so a migration that only does `ADD COLUMN`
leaves every existing row unlimited — it fails **open**. Follow the `ADD
COLUMN` with an `UPDATE "SubscriptionTierConfig" SET … WHERE "tier" = …` for
each tier, and update `TIER_CONFIGS` in `prisma/seed.ts` to match. The seed
cannot cover for you: it never touches a database it isn't pointed at, and it
does not overwrite existing tier configs. `maxVendorSpaces` and
`maxMemoryHubBytesPerEvent` were both added without one, so on any database
the seed has never run against they are `null`, i.e. unlimited. There is no
production database yet, so nothing is broken today — the first one must be
populated by hand.

**Role gates hide. Tier gates show, with an upgrade path.** A role
mismatch (an `EVENT_ADMIN` opening User Management) is an authorization
boundary — they will never have access, so hide it entirely. A tier
mismatch (a Spark tenant opening Vendor Space) is a sales opportunity —
show the feature locked, badge the plan it requires, and let them act on
it. Nobody upgrades into something they never knew existed. This applies
to nav items, routes, and buttons alike; a tier-gated route must never
404 on a direct hit.

Where "act on it" leads depends on who is asking and what is gated — and
it is **never the public Pricing page for someone who is signed in**:

- **Signed-in tenant, tenant-scoped feature** (Vendor Space, Vendor
  Discovery). A locked click, or a direct URL hit, raises a confirmation
  — nobody is moved somewhere unannounced — and confirming goes to
  `/subscription`, carrying the reason as `feature` and `requiredTier`
  query params. A direct hit lands on the dashboard with that
  confirmation open. (`TierGateService`, `tierGuard`.)
- **Signed-in tenant, event-scoped feature** (Memory Hub, which an Event
  Pass on that event also unlocks). No confirmation: the user goes to the
  event's Control Center with `?upgrade=<feature>`, which opens a
  two-option prompt — subscribe (`/subscription`), or unlock just this
  event with an Event Pass. (`eventTierGuard`.)
- **Logged-out visitor.** The public `/pricing` page is a marketing
  surface for them, and only them.

Exception: registration-time tier selection is not an upsell surface —
nobody is upgrading before they have an account.

### Session and tokens

**The second factor (the emailed OTP) is once per device, not once per
session.** Passing an OTP on a device issues a *device token*; from then
on that device mints sessions without a code. This is deliberate. On a
phone, closing a tab is not something the user does: Android discards
backgrounded tabs whenever it wants the memory. Anything that ends
sign-in when a tab goes away signs people out at random, mid-task —
that is what caused the OTP bugs this design replaced.

**The session JWT is never persisted — not in `localStorage`, not in
`sessionStorage`, not anywhere.** It lives in `AuthService`'s memory
only, and is minted fresh on every page load by `POST
/api/auth/exchange-session`: a Firebase ID token (proves who, i.e. the
password) plus the device token (proves this device passed an OTP).
Neither alone is enough. Every tab exchanges independently on its own
load; that is expected. A reload is therefore not a logout and needs no
code.

**The device token is the one durable client-side credential, and it
lives in `localStorage` DELIBERATELY** (key `eg.device`). It has to
survive reloads, closed tabs and discarded tabs — that is its whole
purpose. The XSS exposure this implies is an **accepted risk** until
httpOnly cookies land in the production work; it is not an oversight
to be "fixed" by moving it to `sessionStorage` (which dies with the
tab and brings back the Android bug) or into memory (which dies on
reload). Do not move it without replacing the design.

**Only `AuthService` reads or writes credentials** — the device token,
the in-memory JWT, and the OTP-step record (`sessionStorage`, an email
and an expiry, no secret). No guard, interceptor, or component touches
them directly; that boundary is what made removing an earlier bad
implementation a single-file change. (The shared last-activity
timestamp, `eg.last-activity`, is not a credential and belongs to
`SessionActivityService`.)

**Server side:** only a SHA-256 hash of the device token is stored; the
raw value is sent to the client exactly once, in the `verify-otp`
response. Tokens last 30 days from issue and are **not rotated on use**
— every tab exchanges the same token concurrently on load, and rotating
it would make all but the first exchange fail with a 401 and discard
the device (a multi-tab race).

**What revokes a device token:** an explicit logout (`POST
/api/auth/logout`, that one device), a password reset *request* (every
device of that user — revoked when the link is generated, because the
backend never learns whether the reset was completed), and suspending
the user or their tenant (every device). **An idle timeout does NOT
revoke it.**

> **Under review — revoking on password-reset REQUEST.** Anyone who
> knows a user's email can request a reset, so anyone can currently
> force every one of that user's devices back to an OTP. Whoever changes
> that backend behaviour (`forgotPassword` in `auth.service.ts`) must
> update this paragraph in the same change.

**Idle logout** signs out of Firebase (and drops the session) but
**keeps the device token**. With no Firebase identity the next load
cannot exchange, so the user really is signed out — but the device is
still trusted, so signing back in asks for the password and **not** an
OTP. That is the intended trade-off: an idle logout protects an
unattended screen; it is not a revocation. An explicit logout does
revoke, so the next sign-in asks for both.

**Idle is measured from activity, not from the token.** Two clocks,
kept apart (`SessionTimeoutService`):

- **The idle deadline = last activity + the idle limit.** "Last
  activity" is the newest interaction in *any* tab. The warning (60 s
  before) and the idle logout key off this deadline and nothing else.
  It is computed in exactly one place, `SessionTimeoutService`'s
  `idleDeadline()`.
- **The token** is a short-lived JWT that has to be renewed while the
  session lasts. Its expiry only decides *when a new token is needed*:
  near expiry, if the deadline lies beyond it, it is renewed
  (`refresh-session` while still valid, the device-token exchange once
  lapsed). **A renewal or re-mint renews the token without extending
  the deadline** — otherwise a tab that wakes and re-mints would hand an
  unattended screen a fresh idle allowance. Answering the warning
  ("Stay signed in") *is* activity, so it does move the deadline; a
  stray click on the warning's backdrop does not. If the deadline
  arrives with the warning showing and unanswered, the tab logs out —
  unless another tab saw activity after the warning appeared, which
  releases the warning and moves the deadline.

**The idle limit is the session token's own lifetime** (its `exp −
iat`), not a second number kept in the frontend. That couples it to the
backend's session JWT TTL (`SESSION_TOKEN_TTL` in the backend
`auth.service.ts`, 15 minutes): **changing that TTL for any reason
changes the idle timeout too.** Anyone shortening the TTL for security,
or lengthening it for convenience, is also moving the idle logout.

**Idle detection is shared across tabs.** Firebase sign-in is shared by
every tab on the origin, so one tab's idle logout signs out all of
them; "idle" must therefore mean idle in *every* tab, and a tab may only
idle-log-out if no tab was active within the idle limit. Activity is
broadcast between tabs (`BroadcastChannel`) and also written to
`localStorage` (`eg.last-activity`), because a frozen background tab
receives no broadcasts and must read the stored timestamp when it
wakes. Both cross-tab signals are leading-edge throttled to one per
5 seconds; each tab's own in-memory timestamp updates on every
interaction.

**A 401 from the exchange gets one retry.** The endpoint answers the
same 401 for a bad Firebase ID token as for an unrecognised device, and
the device token is the expensive credential to lose (it costs an
emailed code). So a 401 triggers one forced Firebase refresh
(`getIdToken(true)`) and exactly one retry; only a second 401 discards
the device token and sends the user to the OTP step. Never a loop. This
applies everywhere the exchange is called (bootstrap, after the
password step, and a woken tab's re-mint — all through
`AuthService.resumeSession()`).

**A network failure never signs anyone out** — not a dropped
connection, a timeout, a 429 or a 5xx, at bootstrap or mid-session.
Only a server *verdict* ends a session (see `session-failure.util.ts`);
an unanswered request is unknown state, and the client keeps the device
token and Firebase sign-in and retries. This lesson has been learned
twice already.

**The "keep me signed in" toggle is gone on purpose. Do not reintroduce
it.** It offered a catastrophic default as a choice: unticked meant
"sign me out whenever Android reclaims the tab's memory", which nobody
would pick deliberately. Staying signed in is simply how the
application works.

### TypeScript

`exactOptionalPropertyTypes: true`. Use `?? null`, never `undefined`, in
Prisma writes. For partial updates:

```ts
...(data.field !== undefined && { field: data.field })
```

Strict mode and `strictTemplates` are on in both repos. Builds must be
clean, not merely passing with warnings.

---

## 4. Domain rules

### Event lifecycle

```
DRAFT ──publish──> PUBLISHED ──(last day passes)──> COMPLETED (derived)
  │                    │
  └──────cancel────────┴──> CANCELLED (stored, irreversible)
```

- `COMPLETED` is **never stored** — derived at read time from the last
  event day. The database row still reads `PUBLISHED`.
- Every path returning an event returns the **effective** status. A list
  showing `PUBLISHED` while the detail shows `COMPLETED` is a bug.
- `CANCELLED` is stored and has no reversal. Guests may already have been
  told.
- `Event.status` has exactly one writer: `eventRepository.updateStatus()`.
  Do not add another.

**What each status blocks:**

| | Send invites | Share link | Guest RSVP |
|---|---|---|---|
| DRAFT | ✗ | ✗ | ✗ |
| PUBLISHED | ✓ | ✓ | ✓ |
| COMPLETED | ✗ | ✗ | ✗ |
| CANCELLED | ✗ | ✗ | ✗ |

Guest creation and import are allowed in `DRAFT` — organisers build
their list before going live. Guest-facing Memory Hub access (the
public share-token gallery, and guest uploads) is governed by `opensAt`
**and** the event not being `CANCELLED` — not independent of event
status. Neither gate checks `Event.isArchived`. Organiser-side Memory
Hub management (`memory-hub.service.ts`'s non-guest methods) checks
neither `opensAt` nor cancellation — only tenant scoping and tier.

### Public vs private events

Genuinely different workflows, not a toggle:

**Private** — organiser builds the guest list, sends tokenised
invitations. Import, manual add, and send all apply.

**Public** — no organiser-built list. A shareable link is distributed;
guests self-create by RSVPing. Import, manual add, and send are all
rejected server-side.

In the UI, build **two variants**, not one screen with disabled fields.
Offering an action the backend will always reject reads as broken
software.

### Guest contact

Exactly **one** of email or phone at creation. Both fields exist on the
model so the other can be captured at RSVP time. Supplying both is
rejected.

Names are nullable — a guest imported by phone supplies their name when
they RSVP.

Duplicate = same email or phone on the **same event**. The same person
across two events is two unrelated records.

Phone numbers are E.164 (`+27...`). Reject with a specific message
naming the fix, not a generic "invalid".

### Reminders

Manual only — the organiser presses a button; this codebase has no
scheduler by deliberate choice. They go through the same dispatch path as
invitations (`invite-dispatch.service.ts`), so an SMS reminder draws on
the same pool an SMS invitation does: the event's pass bundle if it has
an active pass, otherwise the tenant's monthly quota — never both, and
all-or-nothing on a shortfall.

A guest is reminded only if their invitation was **delivered**
(`Invite.deliveredAt`), they have **not responded** (`PENDING`), the
invite has not expired, and they were not reminded in the last 24 hours
(`REMINDER_COOLDOWN_HOURS`). Archived guests, archived invites and
plus-ones are excluded at query level. Refused outright when the event is
not `PUBLISHED`, is `PUBLIC`, or its RSVP deadline has passed.

The cooldown is claimed atomically before sending (`Invite.lastRemindedAt`)
and released if the send fails, so overlapping requests cannot double-send
and a failed send never starts it. Every attempt, failures included, is
written to `InviteReminderLog`.

### Check-in

Recorded **per event day**, never as one "arrived" flag on the guest: someone
invited to both days of a wedding can be there on Saturday and absent on
Sunday (`CheckIn`, one row per invite + day). It is not `Attendance` — that
is the guest's RSVP answer, and a guest editing their RSVP must never touch
who has been checked in.

The day list shows **everyone invited to that day**, RSVP status per row, so
walk-ins and non-responders can be found, checked in and undone; "expected"
in the counts is only those who said **yes** to that day. Plus-ones are
listed and checked in like anyone else (they have an `Invite`). Check-in and
undo are **idempotent**, and refused only on a draft or cancelled event — a
completed event still accepts corrections. Done by a Tenant Admin or Event
Admin; there is no door-staff role.

### Dates

Every guest-facing date is formatted in **UTC**, through
`shared/utils/guest-date.util.ts` — never `toLocaleDateString`, `getDate()`
and friends on a stored date, which read the *server's* timezone. Every
client date string becomes a `Date` through `parseClientDateTime`
(`shared/utils/date-input.util.ts`), never `new Date(string)`: an offset-less
`2026-09-19T23:59:59` means literal UTC, matching what the frontend assumes,
whereas plain `new Date` reads it in the server's zone. The organiser picks
calendar dates; UTC is the identity that prints back the date they picked.
Events have no timezone of their own (see Known gaps).

### Terminology

| Term | Applies to | Means |
|---|---|---|
| **Suspend** | Tenants and users only | Locked out of the platform |
| **Archive** | Everything else | Soft-deleted, reversible |
| **Cancel** | Events only | Called off, irreversible |

Never use "Delete" in user-facing copy. Nothing is deleted.

---

## 5. UI conventions

Reuse the existing shared component library — button, badge, toggle,
spinner, confirm-modal, toast. Introduce no new colours, fonts, or
component patterns. Use design tokens (`var(--eg-*)`), never literals.

Every list screen needs **loading, empty, and error** states.

**Confirmation modals** match the weight of the action:

- Reversible (archive, publish) — neutral or primary styling, reassuring
  copy: *"can be restored later"*
- Irreversible (cancel) — cautionary styling, explicit about what cannot
  be undone

Never label a modal's dismiss button "Cancel" when the confirm button is
also "Cancel Event".

**Backend messages reach the user.** Surface the API's message rather
than replacing it with generic text. `"'0821234567' is missing a country
code, use +27821234567"` is far more useful than "Invalid input".

**Bulk operation results** get a modal listing every failure with a
specific reason. For imports, the row number must match what the user
sees in Excel.

Tier rejection and partial failure are **different**: one says "nothing
happened, here is why"; the other says "here is what happened". Style
them distinctly, and preserve the user's selection on rejection so they
can adjust and retry.

Required fields are marked with an asterisk.

---

## 6. Testing

Seed accounts (`npm run seed`) exist specifically so authenticated and
cross-tenant flows are testable. Two tenants exist deliberately.

Emails at `@eventgenie.test` cannot receive mail — read the OTP from the
`OtpRecord` table in the dev database.

**Always clean up fixtures**, then re-run `npm run seed` and confirm it
reports everything already exists.
The seed **never overwrites** an existing tier config, tenant or user — a
tenant you put on Celebrate for a test stays there. To reset on purpose:
`--reset-tier-configs`, `--reset-tenants`, `--reset-users` (see the README).

Test against the real dev database. It has caught bugs that pass locally
— a Prisma transaction timeout at 50 rows, for one, that would never
appear against a fast local database or a 5-row fixture.

---

## 7. Report format

Every task ends with a written report covering:

1. **Mismatches found** between the prompt and the actual code
2. **What changed** — quote the important code
3. **Call sites** — every one touched by a changed signature, and what
   happened at each
4. **Test results** — real output pasted, not summarised
5. **What you could not test** and why, stated plainly
6. **Build status**
7. **Anything else found** — flagged, not fixed

---

## 8. Known gaps

Carried deliberately. Do not treat as bugs to fix opportunistically.

- **Guest self-registration on public RSVP is not built.** Public event
  share links currently resolve to nothing.
- **Announcements are not built.** Cancelling an event does not notify
  guests.
- **Refunds are not built.** Cancelling a paid event will need a refund
  pipeline once payments exist.
- **Automated test coverage is thin.** The backend has none. The
  frontend has Vitest unit/integration specs (`ng test`, jsdom, HTTP via
  `HttpTestingController`, Firebase stubbed): thorough on auth and
  session handling — the interceptor, trusted-device bootstrap and
  exchange, logout, the idle timeout and cross-tab activity, the auth
  modal, role and tier guards — plus tier gating, check-in, reminders,
  the control center's send/upgrade paths, the Event Pass panel,
  tenant navigation/routes and the vendor space list. Most screens and
  services have no spec, and nothing runs in a real browser: the
  cross-tab, tab-freezing and Android behaviours in particular are
  verified only by a manual browser run.
- **Events have no timezone.** Every event is implicitly UTC: "23:59:59"
  on a deadline means 23:59:59 UTC for a guest anywhere, so for a UTC+2
  audience it passes at 01:59 the next morning, and for a UTC−8 audience
  mid-afternoon on the stated day. Guest-facing dates are correct (they are
  the calendar dates the organiser picked); only the *instant* a deadline
  passes is off. An `Event.timezone` would fix that and would not change how
  stored dates read back.
- **Check-in by QR is not built.** The check-in endpoint already accepts an
  `inviteToken` in place of a `guestId`, so a scanner is a second input, not a
  second feature — but nothing renders a code yet, and a plus-one's invite
  token is never given to anyone.
- **Twilio SMS is blocked** pending compliance approval. Everything
  except real delivery is testable.
- A deferred technical debt register tracks tenant-isolation and
  restore-path gaps in modules that have no UI yet. **Read the relevant
  section before building any feature that makes them reachable** —
  fixing them inside the feature build is far cheaper than retrofitting.
