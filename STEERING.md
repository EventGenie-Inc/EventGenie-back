# e-velope — Steering

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
line up. It proves nothing about behaviour. Automated tests run against
the test database; manual smoke runs use the dev database with real seed
accounts (see §6).

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

Cross-tenant access has been found and fixed in this codebase **six
separate times** — most recently tickets and custom RSVP fields, which did
no scoping at all. Assume it is missing until you have read the code.

**A sub-resource must belong to the event in its URL, not merely to the
caller's tenant.** Gate on the URL's `:eventId` first, then 404 unless the
record's own `eventId` matches it — the same tenant's other event is as
much a 404 as another tenant's. `program-item.service.ts`,
`event-day.service.ts`, `ticket.service.ts` and `rsvp-field.service.ts`
all follow this; a by-id lookup that only checks the record's OWN event is
the gap to look for.

**Tickets are organiser-only on `/api/events/:eventId/tickets`.** Guests
read tickets only through their invite token (`/rsvp/validate`'s
projection, `POST /api/rsvp/ticket-quote`); the public event page shows
none. Do not reopen these reads to the public.

**Fails closed.** A non-`SUPER_ADMIN` caller with no `tenantId` must never
reach the unscoped branch above — `tenantId ?? undefined` looks harmless
but is exactly how it happens: `null` becomes `undefined`, and an optional
param quietly matches every tenant instead of none. Route it through
`resolveTenantScope` / `isTenantScopeEmptyForList`
(`shared/utils/tenant-scope.util.ts`) instead: a by-id lookup gets the same
404 a real cross-tenant record would, a list gets an empty array. This
state is not only theoretical — a platform-level `EVENT_VENDOR` (assigned
to a `tenantId: null` `VendorSpace` by design, see `vendor.service.ts`)
reaches exactly this path today. Found and fixed once already (Security
Sweep Before G3); it now lives in one shared helper so it can't happen a
second time.

**Refused at creation, for the two roles that must always have one.**
`userService.create` rejects a `TENANT_ADMIN` or `EVENT_ADMIN` with no
resolved `tenantId` — 422, not merely tolerated and caught later by the
fail-closed reads above. Both roles are operationally tenant-scoped
everywhere (`requireTenantAdmin`/`requireEventAdmin`, and every
`resolveTenantScope` call), so a row without one is the same "should never
exist" state, stopped one step earlier. `SUPER_ADMIN` (platform-wide by
design) and `EVENT_VENDOR` (scoped by `VendorSpaceUser` membership, not
`tenantId`) are exempt on purpose — see `ROLES_REQUIRING_TENANT`'s own
comment. Existing rows are never touched by this; it only gates new ones.

**Vendor space visibility, intended design:** a vendor sees a space if
they are a member of it, OR if it is in their tenant and has no members
at all (unassigned spaces are visible to every vendor in the tenant).
Anything else is a 404. **KNOWN DEBT:** the code currently enforces
membership only (`getSpaceForViewer`) and applies the same gap to
services and products. Resolved by the user management feature, which
assigns users to vendor spaces.

### Guest-facing responses

An unauthenticated or token-authenticated endpoint (RSVP, public event
registration, Memory Hub guest routes, ticket purchase callbacks — any
route without `authenticate`) never returns a raw Prisma row or an
`include` wider than what the page shows. Project an explicit shape by
hand, the way `rsvp.service.ts`'s `validate()` and
`event-public.service.ts`'s `toPublicView` already do. A raw
`Invite`/`TicketPurchase`/`MemoryItem` row carries fields a guest must
never see — `editToken`, `createdBy`/`updatedBy`,
`commissionCents`/`ticketPriceCents`/`paymentRef` — and a field added to
the model later leaks automatically unless the projection is an explicit
allowlist, not a spread of the row. Found leaking on `rsvp.service.ts`'s
`submit()` and `memory-hub.service.ts`'s `createGuestItem()` (Security
Sweep Before G3) — both returned the just-written row directly.

**Tier and plan language never reaches guests.** A guest route (no
`authenticate`) never surfaces a subscription tier name, "plan",
"upgrade", or a storage/limit figure derived from billing — that
language only means something to an organiser looking at a pricing
page. Where an organiser-facing error names the plan
(`memory-hub-tier-enforcement.util.ts`'s `assertMemoryHubAccessible`/
`assertMemoryHubQuotaAvailable`, `memory-hub.service.ts`'s
`assertItemAcceptableOrDestroy`), the guest-facing call site passes
`audience: 'guest'` for wording with none of that in it — e.g. "This
event's photo album is full, so new photos can't be added right now."
instead of naming a plan and its MB ceiling. A guest-facing
**availability** endpoint (POST `/api/rsvp/program`, POST
`/api/memory-hub/guest-view`) goes further and gives no reason at all —
`{ available: false }` covers every blocked state (cancelled event, no
program/hub, unpublished, not yet open, tier without the feature)
identically, so the response itself can never leak which one applies.
The product's own internal name for a feature is billing/organiser
vocabulary too, same as a tier name — a guest sees "photo album", never
"Memory Hub" (`memory-hub.service.ts`'s `requestGuestUploadSignature`/
`createGuestItem`, `memory-hub-tier-enforcement.util.ts`'s
`assertMemoryHubAccessible`); the organiser-facing branch of the same
functions keeps saying "Memory Hub".

**Guest rate limits are keyed by credential, not by IP, whenever the
credential is available.** The Memory Hub guest upload endpoints
(`guest-upload-signature`, `guest-items`) used to be keyed purely by
IP — wrong for the identical reason `/exchange-session`'s limiters
are not (see "Session and tokens" below): guests at one venue's WiFi,
or on South African mobile networks behind one shared carrier-grade
NAT IP, all present as ONE IP, so an entire event shared a single
~10-photos-per-5-minute budget, nothing to do with abuse.
`memoryHubGuestUploadLimiter` is now keyed by the SHA-256 hash of the
invite **token** from the request body (never the raw token, same "a
rate limiter's own in-memory store must not hold a live credential as
a literal key" rule as the device-token limiter) — 60 requests / 5
minutes **per invite**, so one guest's budget is never affected by how
many others share their network. `memoryHubGuestUploadIpLimiter` sits
alongside it as the abuse backstop a per-credential limiter alone can't
provide (a script minting a fresh token per request would get a fresh
per-invite budget every time) — 100 **failed** requests / 5 minutes per
IP, `skipSuccessfulRequests`, generous enough that real multi-guest
traffic on a shared IP never approaches it. The budget itself is never
hardcoded on the frontend — `POST /api/memory-hub/guest-view`'s
`limits.uploadRequestsPer5Min` reports the same constant the limiter
enforces (`upload-constants.ts`'s
`MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN`).

### Client-supplied Cloudinary assets

**A client-supplied Cloudinary publicId is checked with
`isSignedPublicIdInFolder` before it is stored or deleted.** Every upload
is signed into a folder that names its owner, with a server-chosen
`<uuid>` public_id (`src/modules/upload/upload-folders.ts` builds every
folder, for signing and checking alike). The browser then reports the
publicId back, and it is just a string: this server holds the API secret,
so an unchecked publicId handed to `destroyAsset` deletes whatever asset
it names, other events' and other tenants' included. PublicIds are
readable in any Cloudinary URL, which every guest sees. Check against the
folder for the exact owner (this event, this tenant) and 422 otherwise,
**before** any path that could destroy it. The URL stored beside it gets
the same treatment: `isCloudinaryDeliveryUrlFor` ties it to exactly the
checked publicId, so a vetted id can't sit next to a URL pointing
anywhere else. Found missing on Memory Hub guest and organiser uploads,
event covers (create, update, wizard materialize) and Memory Hub
`mediaUrl`; invitation designs were built with both checks. An id
already stored on a record is not re-checked when re-sent unchanged.

### Email

**Every email is rendered by one layout,** `renderEmail`
(`shared/messaging/email-layout.ts`), and sent by one function,
`sendEmail` (`shared/messaging/email.engine.ts`). Never call Resend
directly, and never hand-write email HTML. A builder describes its message
as blocks of **plain text** (`seal`, `eyebrow`, `title`, `paragraph`,
`image`, `details`, `code`, `button`). The layout turns the same blocks
into the HTML part and the plain-text part, so the two always match.
`sendEmail` requires `text`, so no email leaves without a plain-text part.
Builders: `invite-message.util.ts` (invitation, reminder) and
`auth-email.util.ts` (sign-in code, password reset).

**Escaping lives in the layout.** Every text and every URL in a block goes
through `escapeHtml` (`shared/utils/html.util.ts`) on its way into the
HTML, attribute values included. That covers organiser-typed values (event
name, host name, day label, venue, address, design alt text) and
guest-typed ones (a name captured at RSVP). Builders pass raw text and
never markup: an event named `<script>...</script>` must not become live
markup in a guest's inbox, sent under e-velope's own address. A block that
took HTML would bring back the gap the Security Sweep Before G3 found in
`buildInviteEmailHtml`.

**Headers are not HTML.** Organiser text that reaches a header (the
invitation's From name, the subject) goes through `email-address.util.ts`:
control characters, line breaks, Unicode line separators and bidi
overrides become spaces, angle brackets are dropped, the display name is
capped at 60 characters, and `formatFromHeader` always sends it as a
quoted string, with `\` and `"` escaped.

**The layout.** Table layout, inline styles, a 600px column, system serif
and sans-serif stacks (no web fonts, no SVG). Brand blue `#3452E1` for the
one button, ink `#14161F` for text, white card, and these email-only
neutrals: page `#F6F5F2`, muted text `#5C6070`, hairline `#E6E4DF`. A
`<style>` block only adds dark-mode overrides (Apple Mail, iOS Mail,
Outlook.com); everything reads correctly without it. Header:
`e-velope-logo-email.png` shown 200px wide, alt "e-velope". Footer: "Sent
with e-velope · e-velope.co.za" and a line saying why the reader got it.
Every email has a hidden preheader. **Every URL is built from
`FRONTEND_BASE_URL`** (`frontendUrl`, `shared/utils/frontend-url.util.ts`),
including the logo and seal under `<base>/brand/`. The only other URLs in an
email are the ones passed in: a Cloudinary design image and Firebase's reset
link. Never write a domain into an email.

**Guest emails (invitation, reminder).** From `"<host name> via e-velope"
<RESEND_INVITE_EMAIL>`, where the host name is `Event.hostName`, falling
back to the event name. Reply-To is the organiser who created the event, so
replies reach a person; there is none if that user is archived. Subjects:
"You've received an e-velope from <host>" / "Your e-velope from <host> is
waiting". **Never "RSVP" in a subject.** Body: the seal, the eyebrow, the
event name in serif, "From <host>" when there is one, an UPLOAD design's
image, each invited day (date and UTC time via `guest-date.util.ts`,
venue, address; labelled when there are several), and one button, "Open
your e-velope". The preheader is the event name, plus the date and venue of
the guest's first invited day. A reminder adds the reply deadline when
there is one.

**The design image** is shown only for an `UPLOAD` design, rewritten to an
explicit JPEG (`f_jpg,w_1200,c_limit`, displayed at 600px) with its alt
text. **Never `f_auto` in email**: image proxies fetch with their own
`Accept` header. A URL not in the Cloudinary `image/upload` shape is left
out, never sent as it is. TEMPLATE designs aren't shown in email.

**Auth emails** use the same layout, calm and functional: no seal, no
wordplay. From `"e-velope" <RESEND_FROM_EMAIL>`. "Your e-velope sign-in
code" (the code, its validity from `OTP_TTL_MINUTES`, the ignore line) and
"Reset your e-velope password" (one "Reset password" button, the link's
1-hour Firebase expiry, the ignore line).

**Firebase email.** Firebase's own email templates and its hosted action
page (`<project>.firebaseapp.com/__/auth/action`) are **not used**: their
settings are locked on our Firebase projects. Every auth email is ours,
rendered by `renderEmail` and sent through Resend, and every link in it
points at the frontend. Firebase only mints the code: `forgotPassword` calls
`generatePasswordResetLink` (`handleCodeInApp: false`, the web value),
keeps only the `oobCode`, and emails
`<FRONTEND_BASE_URL>/auth/action?mode=resetPassword&oobCode=…&continueUrl=<FRONTEND_BASE_URL>/dashboard&lang=en`,
every parameter URL-encoded (`password-reset-link.util.ts`). The frontend's
`/auth/action` page applies the code with the Firebase client SDK, then goes
to `continueUrl`. The `oobCode` is a live credential, so it is never logged.
If it can't be extracted, no email is sent (never a broken or
Firebase-hosted link), the failure is logged without the code, and the
response stays the generic one.

**Checking by eye:** `TEST_EMAIL_TO=<address> npx tsx
scripts/send-test-emails.ts` sends one of each email to that address and
nowhere else.

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
becomes a 500 with one generic message in **every** environment (its raw
text can carry Prisma model names, query arguments and SQL), and the real
reason survives only in the server log.

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

**Machine-readable codes.** `HttpError(status, message, code?)` — a
third, optional argument, backward compatible: every call site that
omits it keeps returning a plain response with no `code` field, exactly
as before. The global handler includes it only when present:
`{ status: 'error', message, code? }`. Add a code when — and only
when — a client needs to tell two same-status failures apart to decide
what to do next, not as a matter of course on every `HttpError`. Two
established pairs: `SESSION_EXPIRED`/`SESSION_INVALID` (`authenticate`
middleware and `POST /api/auth/refresh-session`, decide whether a
silent retry is worth attempting) and `FIREBASE_TOKEN_INVALID`/
`DEVICE_NOT_RECOGNISED` (`POST /api/auth/exchange-session`, Trusted
Devices — decide whether to refresh the Firebase token and retry once,
or discard the stored device token). The client acts on each code: see
"A 401 from the exchange is acted on by its code" under "Session and
tokens". It keeps the old behaviour (one refresh and retry, then discard)
only for a 401 with no code, so it stays correct against an older
backend mid-deploy.

One single code: `OTP_SEND_FAILED` (`POST /api/auth/request-otp`, 503,
"We couldn't send your code. Try again in a moment."): the sign-in code
email could not be sent, so the client shows that and offers a retry
instead of a code step that will never receive one. The provider's reason
stays in the server log. Saying so is safe: this caller has already passed
the password step, so it reveals nothing about which emails have accounts.
`POST /api/auth/forgot-password` is the opposite case and has **no** code
for any failure: anyone can call it with any email, so every outcome
(unknown email, suspended account, a reset link that couldn't be built, a
failed send) returns the same generic 200.

One trio: `CONTACT_PHONE_INVALID`, `CONTACT_PHONE_NOT_INTERNATIONAL` and
`CONTACT_LAST_REMOVED` (`POST /api/rsvp/submit`, all 422) tell the RSVP
form which contact field to mark: a number that isn't a real one ("Use the
format +27 82 123 4567" when written with a country code), a local number
missing its country code ("'0825551234' is missing a country code, use
+27825551234"), and a guest removing their only contact. The two phone
codes are set by `normalizePhoneToE164` (`guest-validation.util.ts`), so
organiser guest create and import carry them too, still as 400.

A code must never subdivide a case that is already deliberately generic
for security reasons. `DEVICE_NOT_RECOGNISED` covers missing, wrong,
wrong-user, revoked, **and** expired device tokens — one code, matching
the one message already used for all of them — because splitting those
apart is exactly the oracle the single message exists to avoid.
`FIREBASE_TOKEN_INVALID` is safe to keep as its own code precisely
because whoever holds a Firebase ID token can already check its
validity directly with Firebase; there's nothing to leak.

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

### Migrations and the shared database

Dev and prod share one database until the Frankfurt migration. Agents
never apply migrations to it. The human does that at deploy. Agents
apply migrations only to the test database, and only through the
harness behind the refusal guard.

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
the in-memory JWT, and the pending sign-in record (`localStorage`, key
`eg.otp-handoff`: an email and the code's expiry, no secret). No guard, interceptor, or component touches
them directly; that boundary is what made removing an earlier bad
implementation a single-file change. (The shared last-activity
timestamp, `eg.last-activity`, is not a credential and belongs to
`SessionActivityService`.)

**Server side:** only a SHA-256 hash of the device token is stored; the
raw value is sent to the client exactly once, in the `verify-otp`
response. **Trust extends while the device is in use:** a token is
issued for 30 days, and each successful `exchange-session` moves its
expiry to now + 30 days — but never past 90 days after it was issued
(`createdAt`). At 90 days it is refused however recently it was used,
and the next sign-in asks for a code again. An extension never shortens
an expiry already set. The token is **not rotated on use** — only the
expiry moves, the value stays the same. Every tab exchanges the same
token concurrently on load, and rotating it would make all but the
first exchange fail with a 401 and discard the device (a multi-tab
race).

**What revokes a device token:** an explicit logout (`POST
/api/auth/logout`, that one device), and suspending the user or their
tenant (every device). **An idle timeout does NOT revoke it, and nor
does merely requesting a password reset.** Anyone who knows a user's
email can request a reset, so revoking every device on the request
alone cost real users' devices — and, once SMS delivery is live, real
money — for no security gain: a **completed** reset already ends every
existing sign-in on its own. Firebase invalidates the account's
existing tokens the moment the password changes, and both
`exchangeSession` and `refreshSession` verify with `checkRevoked` (see
`verifyFirebaseTokenStrict` in `auth.service.ts`), so a device token
paired with the OLD password's Firebase session simply stops working
the instant the reset completes — nothing in this backend has to notice
or act.

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

**A 401 from the exchange is acted on by its code.** The endpoint says
which credential it refused (see "Machine-readable codes" under
Errors), and the device token is the expensive credential to lose (it
costs an emailed code), so the client never discards it on a guess.
This applies everywhere the exchange is called (bootstrap, after the
password step, and a woken tab's re-mint — all through
`AuthService.resumeSession()`):

- `DEVICE_NOT_RECOGNISED` — discard the device token. No Firebase
  refresh, no retry: a fresh ID token cannot change that answer. After
  the password step the code step follows; on a page load, see below.
- `FIREBASE_TOKEN_INVALID` — one forced Firebase refresh
  (`getIdToken(true)`) and exactly one retry. Success keeps the device
  token. A second `FIREBASE_TOKEN_INVALID`, or Firebase itself refusing
  the refresh (`auth/user-token-expired`, `auth/invalid-user-token`),
  means the Firebase identity is gone — most likely a password reset
  completed elsewhere: sign out of Firebase, **keep** the device token,
  and show the password screen with a calm "Please sign in again". The
  device is still trusted, so no OTP follows. `DEVICE_NOT_RECOGNISED`
  on the retry is handled as above; a refresh that fails on the network
  is unknown state, and nothing is cleared.
- **No code, or a code this client does not know** — the pre-code
  behaviour: one forced refresh and one retry, and only a second 401
  discards the device token. Kept deliberately so the frontend stays
  correct against an older backend during a deploy. Do not remove it.

Never a loop: at most one retry, on any path.

**A page load never sends a code and never opens the code step.** This
replaces the old rule that a Firebase user with no usable device token
went straight to the code step (which emailed a code nobody asked for,
on devices people believed were trusted). When a load finds a Firebase
user but no usable device token — none stored, or the exchange answers
`DEVICE_NOT_RECOGNISED` (or the no-code fallback's second 401) — the
client signs out of Firebase, keeps nothing half-signed-in, and shows
the normal sign-in screen with a calm "Please sign in again on this
device." The code step appears only right after the person submits
their email and password, and the code is requested only then.

**A sign-in in progress is visible to every tab.** Reaching the code
step writes the pending sign-in record (above) to `localStorage`, valid
until the code itself expires. While a fresh record exists for the
signed-in Firebase account, a page load in ANY tab leaves Firebase
signed in (signing out is shared by every tab and would end the code
step the user is in the middle of) and shows that code step, sending
nothing. That also covers a reload, or a tab Android discarded, while
the person reads their email. The record is read, never consumed by a
load; it is removed when the code is verified, the step is abandoned
(the back arrow), the session ends, or it is found expired. From then
on the rule above applies again. A late background retry of a load
that had no verdict never touches a sign-in the user started in that
tab meanwhile.

**A refresh after a completed password reset ends the session the
same way.** `refresh-session` verifies with `checkRevoked`, so once a
reset completes elsewhere, an open session's next refresh is refused
with a **401 that carries no code** ("Firebase token is invalid or has
expired"). That endpoint's only coded 401s are `SESSION_EXPIRED` and
`SESSION_INVALID` (the session JWT itself failed); any other 401 on the
refresh request — the revoked token, a uid mismatch, a user gone — is a
verdict on the Firebase side, and ends the session as above: Firebase
signed out, device token kept, the password screen with "Please sign in
again". It is never treated as a network failure (retried), and never
clears the device token. A 403 from `refresh-session` (suspended
mid-session) shows the inactive-account message and forgets the
device, exactly as at bootstrap. Both are decided on the refresh
request itself, in the interceptor, because the proactive refresh and
the idle timer swallow a failed refresh.

**Rate limits on `/exchange-session` and its per-device limiter count
only FAILED attempts** (`skipSuccessfulRequests`). Guessing is failures
by definition, and a successful exchange is the endpoint working as
designed on a path every ordinary page load takes — counting it too
meant legitimate multi-tab use could exhaust the per-device budget on
its own, and, sharper still, South African mobile networks put many
unrelated users behind one shared carrier-grade NAT IP, so counting
successes against the IP limiter could throttle unrelated real users
the moment that shared IP's routine traffic passed the ceiling, nothing
to do with abuse. The per-device limiter keys on the SHA-256 hash of
the submitted device token, never the raw value — a rate limiter's own
in-memory store must not hold a live credential as a literal key any
more than the database should.

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

**A guest may update their own contact at RSVP** (`POST /api/rsvp/submit`,
`email`/`phoneNumber`): a value sets it (normalised by the same functions
guest import uses, 422 with import's specific message when invalid),
`null` removes it, omitted or blank leaves it alone. A guest can never
remove their only contact (422). Each refusal carries its code (see
"Machine-readable codes" under Errors). Dispatch reads the guest's contact at
send time, so a changed number reaches future invites and reminders by
itself; removing the channel the invite goes out on moves
`Invite.deliveryMethod` to the one they kept.

### Venue

**The venue belongs to the event day, not the event.** Every `EventDay`
has its own `location` (venue name), `address`, `latitude`, `longitude`.
The columns are nullable only so the migration that introduced them could
backfill old events; the API requires a non-blank location and address on
every day create and update (422), judged on the day an update leaves
behind (`event-day-venue.util.ts`, shared with the wizard's materialize).
Coordinates come from the frontend's HERE address lookup, both-or-neither,
and are cleared when the address changes without new ones — this backend
never calls HERE on save. Anywhere a venue is shown reads it from the day:
`/rsvp/validate` and `/rsvp/program` per day, invitation and reminder
emails from the guest's own invited days (one line per day when several),
the check-in roster's day, vendor proximity and organiser lists from the
first day by date. Publishing refuses an event with a day that has no
venue. Event create and update take no venue at all (an older client
still sending one is ignored, not refused). The Event's own `location`,
`address`, `latitude` and `longitude` columns are dropped
(`20261004090000_drop_event_venue_columns`). `/rsvp/validate`'s and the
public event view's `event.location`/`address` (and validate's
coordinates) remain as compatibility keys, filled from the first day's
venue.

### Event program

A program is **visible to guests by default** (`isPublished` true on
creation); `isPublished: false` hides it. A program item created without
`order` goes to the end of its program's list.

`ProgramItem.eventDayId` is nullable — `NULL` does not mean "no day
assigned" or an error state, and it is **not** unconditionally "every
day" either. A day-scoped item (`eventDayId` set) shows only under that
one day, unchanged. A `NULL` item is guest-facing-rendered
(`POST /api/rsvp/program`, `eventProgramService.getProgramForInvite`)
by matching its `startTime`'s **UTC calendar date** against the
event's own `EventDay.date`s: if exactly one (or more, if two days
somehow share a date) of the event's days has that date, the item shows
under that day only, same as if `eventDayId` had been set explicitly.
Only when the item's date matches **none** of the event's days does it
fall back to the old "standing item" behaviour — shown under every one
of the **guest's invited** days (never every day on the event; a guest
sees only their own invited days regardless). Date matching happens
against the full event, but display scope always stays the guest's
invited days. Within a day, items are sorted by `startTime` then
`order`. `eventDayId`, when provided on create/update, must belong to
the same event as the program itself — 422 otherwise.

The organiser program UI sets `eventDayId` through a day picker on every
item, required when the event has more than one day and hidden on a
single-day event (where an item is left `NULL` and date-matching above
places it). The API requires it too: on an event with more than one live
day, creating an item without `eventDayId`, or clearing it, is 422. An
update that leaves it out keeps what is stored, so an older `NULL` item
can still be edited. Items created before the picker, and any left `NULL`,
still resolve by date as described.

The wizard's materialize does it all in its one transaction. Each program
item names its day by `dayIndex`, its position in the draft's `days` list
(the days have no ids until materialize creates them): required on a
multi-day draft, optional on a single-day one (left `NULL`), 422 when it
isn't a whole number naming one of the draft's days. `program.isPublished`
is honoured (absent means visible). No follow-up calls are needed.

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

### Invitation designs

An event has at most one active `InvitationDesign` (a partial unique
index in its migration, since Prisma can't express one): a **TEMPLATE**
(a frontend-defined template, `templateId` + `templateVersion`, plus the
organiser's `overrides`) or an **UPLOAD** (an image in the event's own
Cloudinary folder). Switching kind rewrites the same row. Guests get it
as `design` on `GET /api/rsvp/validate/:token`, through the explicit
projection in `invitation-design-guest.util.ts`.

**The font allowlist exists in both repos and must always change
together.** The backend copy is `INVITATION_FONT_ALLOWLIST`
(`src/modules/invitation-design/invitation-design-fonts.ts`, canonical);
the frontend holds an exact copy. Change the backend first, then the
frontend, in the same piece of work. A font the frontend offers but the
backend lacks is a 422 on save; one the backend allows but the frontend
never loads falls back to a system font on a guest's card. Every entry
must be a Google Fonts family, spelled as Google spells it. A template
that uses a new font adds it here first. Removing a font breaks re-saving
every design that already uses it.

**No free-form CSS, ever.** An override is
`{ elements: { [elementId]: { color?, backgroundColor?, fontFamily?,
fontSize?, text? } } }` and nothing else: colours `#rrggbb` only, fonts
from the allowlist, `fontSize` a number within the global range, `text`
plain and bounded. Every unknown key, at any level, is a 422 and never
silently dropped. A new styleable property is a new named, validated
key, never a pass-through string.

**Template versions never change once saved.** A saved design pins
`templateId` + `templateVersion`; the frontend must keep rendering every
version it has ever shipped exactly as it was, because saved overrides
name element ids and assume that version's layout. A changed layout is a
new version number, never an edit to an existing one.

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

### Modals

Every modal renders inside the shared shell, `<app-modal>`
(`src/app/shared/components/modal/`); `ConfirmModal` is built on it. A
modal never builds its own backdrop.

- **A tap on the backdrop never closes a modal.** On a phone it is
  nearly always an accident, and it threw away what had been typed.
- A modal closes only through its own Close (✕, `<app-modal-close>`,
  visible and 44×44) or Cancel button (`requestClose()`), or Escape.
- **With unsaved changes**, each of those first asks "Discard your
  changes?" (Keep editing / Discard). Unsaved is real state wherever
  the form layer can supply it: the form's `dirty()` for an edit form
  that knows what is saved (`changed`); else its `modified()`, which
  compares the form's `value` with what it held when the modal opened
  (`reset()`), so a change made by a button (the day editor's "Same
  venue as day 1") counts and one put back does not. Every form-layer
  form in a modal supplies `value`. Only a form outside the form layer
  (the vendor forms) falls back to "anything typed since the modal
  opened". The owner's own `dirty` input overrides all of these.
- A purely informational modal (nothing to type) closes on Escape with
  no question. Only the top modal answers Escape.
- `dismissible: false` (the idle warning, whose Cancel is "Log out"):
  no ✕ and Escape does nothing; its own buttons still work. While a
  request is in flight (`busy`), nothing closes a modal.
- The auth modal keeps its own stricter rule: Escape does not close it
  either (see `AuthModal`).

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

Required fields are marked with an asterisk — only fields the server
requires.

### Form validation

Every frontend form (vendor forms excepted, for now) validates through
one shared layer, `src/app/shared/forms/`. No form builds its own.
Signals and explicit `(input)` handlers, as above; not the Forms API.

- **Rules** (`rules.*`): required, email (the backend's own pattern),
  phone (the backend's own check: same `libphonenumber-js` version, pinned
  in both repos; a local `082…` number gets the backend's "missing a
  country code, use +27…" message), whole number / number range,
  maximum and minimum length, pattern, matches, date and time order
  (`after`, `notAfter`, `notBefore`), and custom. A form is a list of
  field checks (`field()` for a value it owns, `check()` for one held
  elsewhere), each keyed by its control's DOM id.
- **Rules mirror the backend.** Required fields come from its
  required-field audit, formats and limits from its validation: the UI
  never accepts what the server refuses, nor refuses what it accepts. A
  rule the backend lacks is added only when a task asks for it, and is
  listed for a backend follow-up — fix the backend, don't drift.
- **Behaviour, identical in every form:** a field's error appears when it
  is left (blur), not while it is first typed, and then updates live.
  Save/Next *looks* disabled while the form is invalid, or in an edit
  form while nothing has changed (`aria-disabled`, never the `disabled`
  attribute), with a line beside it ("Complete the highlighted fields to
  continue." / "No changes to save yet."). Tapping it saves nothing, marks
  every field touched, shows every error and moves focus to the first.
  While saving, the button shows progress and can't be pressed again.
  A wizard's Next checks its own step only.
- **Pieces:** `createForm()` (valid, dirty, submitting, first invalid
  field; `begin()` at the top of every submit handler, `end()` when the
  save settles), `FormFieldDirective` (`[egField]` on a native control:
  `aria-invalid`, `aria-describedby` to `<id>-error`, touch on blur),
  `FieldError` (`<app-field-error>`, the message under the field), and
  `SubmitButton` (`<app-submit-button>`). A custom control (password,
  address search, colour) takes `inputId`/`invalid`/`describedBy` inputs
  and emits `blurred`.
- **Server errors:** a 422/409 the backend ties to a field (its message
  names the value) goes beside that field with `failField()`; anything
  else stays in the form's banner.
- **Messages** are short and plain: "Enter the venue name", "Use the
  format +27 82 123 4567", "The end time must be after the start time" —
  never "Invalid input" or "This field is required".
- A numeric field where blank means something (unlimited) is a text input
  with `inputmode="numeric"`, so a typo reaches the rule instead of the
  browser silently turning it into blank.

### Brand

The public brand is **e-velope** (website: e-velope.co.za; tagline:
"Make it Memorable"). Internal names stay as they are and are never
renamed as brand work: classes, files, services, packages, storage keys
(`eg.*`), the `eg-` CSS prefix, Cloudinary folders, and the repo names
`EventGenie-back` and `eventgenie-front`.

**Rules.** Always "e-velope", lowercase, even at the start of a sentence
or heading. Never "E-velope", "Evelope" or "EventGenie". Where a sentence
reads awkwardly with the brand lowercase at the start, rephrase it ("We
offer…", "The e-velope platform is…"); never capitalise it. CSS that
uppercases text must not reach the brand either: an eyebrow containing
it carries `eg-eyebrow--brand`, which turns the transform off.

**Voice.** The invitation a guest receives *is* an e-velope: something
personal that arrives, gets opened, and gets answered. Like real post,
but better. "e-velope" is a noun (plural "e-velopes"): you send one,
receive one, open yours.

- **Guest-facing copy uses it.** "You've received an e-velope", "Open
  your e-velope", "Your reply is on its way back to Thandi & Sipho".
  Guests still never see internal feature names (see "Guest-facing
  responses"): "photo album", not "Memory Hub".
- **Landing and marketing copy uses it.** "Send an e-velope",
  "Invitations people actually open".
- **Organiser working screens don't.** Guest lists, check-in, payments,
  settings and tables keep plain words ("event", "invitation",
  "guests"), so they stay clear. The two exceptions are the main send
  action ("Send e-velopes") and its confirmation ("Your e-velopes are on
  their way").
- **Restrained and warm, never cute.** No puns stacked on puns; one
  e-velope reference per screen is plenty.

**Logo files** live in the frontend's `public/brand/`. Frontend code
reads the SVGs through `src/app/shared/brand/brand-assets.ts`, never a
literal path. The SVGs are the source; every PNG is generated from them
by `npm run brand:assets` (`scripts/build-brand-assets.mjs`, resvg).
Never edit a PNG by hand, and re-run the script after changing an SVG.
The icon is the sealed envelope from the guest's invitation reveal; its
lettering is outlined to paths, so no file depends on a font.

| File | What | Used by |
|---|---|---|
| `e-velope-logo.svg` | The icon: envelope and wax seal, square | Wedding template footer mark; source of the app icons and email seal |
| `e-velope-logo-white.svg` | The icon in white | Dark backgrounds (nothing uses it yet) |
| `e-velope-lockup.svg` | Icon beside the word "e-velope" | Site header and footer (light), tenant and admin shells |
| `e-velope-lockup-white.svg` | The lockup in white | Site header and footer in dark mode, or over a photo |
| `e-velope-seal.svg` | The icon's wax seal alone | Guest invitation reveal, which draws its own envelope |
| `e-velope-favicon.svg` | Icon simplified for 16–32px | Favicon; source of the PNG favicons |
| `e-velope-favicon-16.png`, `-32.png` | Favicons | `index.html` |
| `e-velope-apple-touch-icon.png` | 180px, on white | `index.html` |
| `e-velope-icon-192.png`, `-512.png` | App icons | Web manifest; the 512 is also `og:image` |
| `e-velope-logo-email.png` | Lockup, 400px wide (2x for 200px), transparent | Email headers (backend) |
| `e-velope-seal-email.png` | Icon, 128px (2x for 64px), transparent | The seal in invitation emails (backend) |

Email clients don't show SVG, and dark-mode clients show the same PNG on
a dark background. So the email PNGs are transparent and use only
colours that read on both: the solid-blue icon, and the wordmark in
`#4C6EF5` (4.3:1 on white, 3.8:1 on `#1F1F1F`) rather than the ink the
site uses. A copy kept anywhere else is regenerated from these files,
never redrawn.

**Colour tokens** live in `:root` in the frontend's `src/styles.css` and
are the same in both themes. The logo files and the backend's emails use
exactly these hex values:

| Token | Hex | Use |
|---|---|---|
| `--eg-brand-blue` | `#3452E1` | Envelope and wax seal; the primary brand colour |
| `--eg-brand-blue-deep` | `#253BB3` | Closed flap; seal ring |
| `--eg-brand-blue-bright` | `#4C6EF5` | Envelope folds; the email wordmark |
| `--eg-brand-ink` | `#14161F` | Wordmark on light backgrounds |
| `--eg-brand-paper` | `#FFFFFF` | The seal's "e"; wordmark on dark backgrounds |

Change one and you change all three together: the token, the SVGs (then
re-run `npm run brand:assets`), and the backend's email colours.

**Coloured words in headings use `--eg-emphasis`**, never `--eg-gold`
(the italic in a call-to-action title, a hero's highlighted word). It is
the brand blue on light and the dark theme's own accent (`#8CA0FF`) on
dark: the brand blue on the dark surface is 2.8:1, below the 3:1 large
text needs.

**MashWare.** The frontend's `/mashware` page says who built e-velope, and
the footer carries a quiet "Built by MashWare" line linking to it. The
files are in `public/brand/mashware/`, read through `brand-assets.ts`:

| File | Use | Alt text |
|---|---|---|
| `mashware-logo.svg` | Full logo with tagline, olive lettering: `/mashware` in light mode | "MashWare — Brave As Code, Emerging While Others Crash" |
| `mashware-logo-dark.svg` | The same with gold lettering: `/mashware` in dark mode | the same |
| `mashware-mark.svg` | Olive tile, gold "M": the footer, in both modes (there is no white version) | "MashWare" |

**The one exception to "no new colours"** (§5) is that page. MashWare's
olive `#3B4630` and gold `#E0C36F` are custom properties scoped to it, and
appear as accents only: the grid's icons, the quote's rule, a faint wash
behind the call to action. They are never text and never a solid
background; every word on the page uses e-velope's tokens. Olive is the
accent in the light theme and gold in the dark, because each fails the
other: olive on the dark background is 1.84:1, gold on white 1.72:1, both
below the 3:1 a non-text accent needs. No other page uses these colours.

---

## 6. Testing

**Automated tests (Vitest, `tests/`) run against `DATABASE_URL_TEST`
only** — a separate Neon database, never the shared dev/prod one. The
isolation guard (`resolve-database-url.util.ts`) refuses to run
otherwise. New migrations reach it through the guarded harness
(`npm run test:db:reset`, or `NODE_ENV=test npx prisma migrate deploy`);
see "Migrations and the shared database". Fixtures are created and
hard-deleted by the tests themselves (`tests/helpers/`). The test database
is still a real remote Postgres, which is what catches round-trip bugs
like the Prisma transaction timeout at 50 rows that a fast local database
or a 5-row fixture would never show.

**Manual smoke runs use the dev database** with the seed accounts
(`npm run seed`). They exist specifically so authenticated and
cross-tenant flows can be clicked through, and two tenants exist
deliberately. Nothing automated ever points at dev.

The seed accounts are `superadmin@`, `tenantadmin@`, `eventadmin@` and
`sparkadmin@evelope.test` (`prisma/seed.ts`). Addresses at `@evelope.test`
cannot receive mail, so read the OTP from the `OtpRecord` table in the dev
database.

**Always clean up smoke-run fixtures**, then re-run `npm run seed` and
confirm it reports everything already exists.
The seed **never overwrites** an existing tier config, tenant or user — a
tenant you put on Celebrate for a test stays there. To reset on purpose:
`--reset-tier-configs`, `--reset-tenants`, `--reset-users` (see the README).

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
- **Automated test coverage is thin.** The backend has a Vitest suite
  (`npm test`, `tests/`) on real Postgres in a separate
  `DATABASE_URL_TEST` database (never the shared dev/prod one — see
  `resolve-database-url.util.ts`'s isolation guard), Firebase Admin
  stubbed at exactly `verifyIdToken`. Tests are HTTP-level (`supertest`
  against the real Express app) or call a service directly, and cover
  targeted guarantees rather than whole modules:
  - **Auth** (`tests/auth/`): `exchange-session` and `logout`
    (valid/garbage/wrong-user/expired device tokens, the
    `FIREBASE_TOKEN_INVALID`/`DEVICE_NOT_RECOGNISED` codes, a suspended
    user refused cleanly rather than a masked 500), `refresh-session`'s
    strict Firebase verify, `forgotPassword` no longer revoking on
    request, both rate limiters (`skipSuccessfulRequests`, hash-keying),
    `DeviceToken.userAgent`, only the token's hash ever stored, the
    `authenticate` middleware, the test-database isolation guard, and
    username escaping in auth emails.
  - **Tenant scoping** (`tests/tenant-scope/`): fail-closed lookups for
    a caller with no tenant, event program and program items across
    tenants, vendor-space membership, `TENANT_ADMIN`/`EVENT_ADMIN`
    refused without a tenant at creation, tickets and custom RSVP fields
    across tenants and under the wrong event (plus the SPARK custom-field
    gate and organiser-only ticket reads), and event days under the wrong
    event.
  - **Program defaults** (`tests/event-program/`): visible by default on
    both creation paths and still hideable, the publish migration, and a
    program item's `order` defaulting to the end of the list.
  - **Guest-facing responses**: RSVP `submit()`'s exact response shape,
    the guest program contract, archived event days hidden from guests
    and refused at submit (`tests/rsvp/`); Memory Hub guest view,
    guest-safe wording and the per-invite upload rate limit
    (`tests/memory-hub/`); invite email escaping (`tests/invite/`).
  - **Emails** (`tests/email/`): every email through the shared layout,
    with a plain-text part, every user value escaped, the sender name
    sanitised, no "RSVP" in a subject, the design image only for UPLOAD,
    and every URL built from `FRONTEND_BASE_URL`.
  - **Invitation designs** (`tests/invitation-design/`): cross-tenant
    404, cancelled-event 409, every 422 validation, create/replace/switch
    kind, and the guest projection's exact keys.
  - **Day venues** (`tests/event-day/`): a day without a venue is 422
    on create and update, stale coordinates cleared, cross-tenant day
    update 404, the event no longer taking a venue, `hostName` trimmed and
    blank stored as null, publish refusing a venue-less day, and the event
    carrying no venue columns. (The venue migration's data-copy test was
    retired with the columns it read.) Guest side (`tests/rsvp/rsvp-day-venue.test.ts`):
    per-day venues on `/rsvp/validate`, `/rsvp/program` and the sent emails.
  - **RSVP contact update** (`tests/rsvp/rsvp-contact-update.test.ts`)
    and its error codes (`tests/rsvp/rsvp-contact-codes.test.ts`).
  - **Required fields** (`tests/validation/`): 422 on blanks for program
    items, tickets, custom RSVP fields, guests, the wizard's materialize,
    and RSVP submit (attending, name, required custom questions). The
    frontend's form rules on the server (`frontend-rule-parity.test.ts`):
    whole-number durations, ticket quantities and tier limits, day end
    after start, an item's day on a multi-day event, SMS credits 1–5000,
    host name length, typed custom answers, and the international phone
    message and code.
  - **Wizard draft conversion** (`tests/event-draft/`): `hostName`
    carried through (null when absent or blank), a legacy
    `invitationTemplate` in an old draft ignored, and each program item's
    day (`dayIndex`) and the program's visibility set in one step.
  - **Client-supplied Cloudinary assets** (`tests/cloudinary/`): foreign
    publicIds and mismatched URLs refused with nothing destroyed, on
    Memory Hub uploads and event covers.
  - **The global error handler** (`tests/errors/`): no raw Prisma text
    in a response.

  Everything else has no backend test: event CRUD and lifecycle, guests
  and import, invite sending and reminders, check-in, tickets and
  payments, subscriptions and Event Pass, vendor spaces beyond
  membership, and tier enforcement. The frontend has Vitest
  unit/integration specs (`ng test`, jsdom, HTTP via
  `HttpTestingController`, Firebase stubbed): thorough on auth and
  session handling — the interceptor, trusted-device bootstrap and
  exchange, logout, the idle timeout and cross-tab activity, the auth
  modal, role and tier guards — plus tier gating, check-in, reminders,
  the control center's send/upgrade paths, the Event Pass panel,
  tenant navigation/routes and the vendor space list, and the event
  wizard's day venues, program item days and required fields, program
  visibility, guest-facing day venues, and RSVP contact editing. Most screens and
  services have no spec, and nothing runs in a real browser: the
  cross-tab, tab-freezing and Android behaviours in particular are
  verified only by a manual browser run.
- **`npm test` against Neon can hang on dropped connections.** Run test
  files individually until the suite moves to local Postgres.
- **Events have no timezone.** Every event is implicitly UTC: "23:59:59"
  on a deadline means 23:59:59 UTC for a guest anywhere, so for a UTC+2
  audience it passes at 01:59 the next morning, and for a UTC−8 audience
  mid-afternoon on the stated day. Guest-facing dates are correct (they are
  the calendar dates the organiser picked); only the *instant* a deadline
  passes is off. An `Event.timezone` would fix that and would not change how
  stored dates read back.
- **The venue compatibility keys are kept.** The Event venue columns are
  dropped (see "Venue"), but `/rsvp/validate`'s and the public event
  view's `event.location`/`address` (and validate's coordinates), filled
  from the first day's venue, are still sent. The current frontend reads
  none of them. Remove them once no deployed client does.
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
