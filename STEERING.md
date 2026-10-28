# e-velope — Steering

Conventions every contributor and AI coding agent must follow.

> **This file exists in two repos** — `EventGenie-back` (canonical) and the
> frontend repo — and the two copies must be **byte-identical**. Change
> the backend copy first, then copy it over unchanged; never edit only
> one. Check with `diff` or `shasum` on the two files: no difference
> means in sync. A frontend-only agent cannot read the backend repo,
> which is why the copy exists; if you find the two differ, say so
> before relying on either.

> **Where the repos are**, on either machine:
>
> | | Windows | Mac |
> |---|---|---|
> | Backend | `C:\Users\Levy\Desktop\EventGenie-back` | `~/EventGenie-back` |
> | Frontend | `C:\Users\Levy\Desktop\eventgenie-front` | `~/eventgenie-front-1` |
>
> The frontend has this file's copy at its root (`STEERING.md`) and the
> Angular app in its `eventgenie-front` subfolder. On the Mac,
> `~/EventGenie-front` is a legacy prototype, not the frontend. Ignore any
> older path in notes or memory, such as a OneDrive or `C:\dev\…` one.

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
line up. It proves nothing about behaviour. It also checks `src/` only:
`npm run typecheck:tests` (`tsconfig.test.json`) checks the tests with the
same strict settings, and must be clean too. vitest runs a test without
checking its types, so a changed signature used to leave tests calling the
old one until they failed at run time. Automated tests run against
the test database; manual smoke runs use the dev database with real seed
accounts (see §6).

**Prove your tests bite.** When adding a regression test, temporarily
revert the fix, confirm the test fails, restore it, confirm it passes.
Report both runs. A test that only ever passes proves nothing.

### Branches and environments

**Every prompt states which branch to work on.** If it doesn't, ask
before writing code.

| Branch | Is | Deployed to |
|---|---|---|
| `main` | what production runs | staging automatically; production only by hand, after checking staging |
| `dev` | the bigger picture: everything in progress | the dev environment |

Staging is its own Render service, Neon database and frontend site
(`staging.e-velope.co.za`), running `main`'s code with production's
feature flags and `SENTRY_ENVIRONMENT=staging`.

Staging shares dev's Firebase sign-in, with its own database. On staging,
always use +staging email addresses (e.g. name+staging@gmail.com), never
an address used on dev.

**A bug fix for production** goes on `hotfix/<name>`, branched from
`main`: fix it, merge it into `main`, check it on staging, deploy
production, then merge `main` into `dev` **the same day**, so `dev`
never lacks a fix production has.

**A hotfix never includes a database migration.** If one truly seems
needed, stop and say so: the human decides first.

**A new feature** branches from `dev`. `dev` is merged into `main` every
one to two weeks; a feature that isn't finished by then goes in switched
off by its flag (see "Feature flags").

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
much a 404 as another tenant's. A by-id lookup that only checks the
record's OWN event is the gap to look for. A record two levels down checks
both: a Memory Hub item under `/memory-hub/:hubId/items/:id` must be that
hub's, and the hub the URL event's (`hubInScope`/`itemInScope`). An id in a
**body** is held to the same rule: it must be one of the URL event's own
records, or the refusal is the endpoint's own (a 422 or 400 naming no other
event), never a write to another event's.

Every route with a sub-resource id under `/api/events/:eventId`, swept
before the pilot merge:

| Route | |
|---|---|
| `/days/:id` (GET, PUT, DELETE) | safe (`eventDayService.getById`) |
| `/tickets/:id` (GET, PUT, DELETE) | safe (`ticketInScope`) |
| `/rsvp-fields/:id` (GET, PUT, DELETE) | safe (`fieldInScope`) |
| `/program/:programId/items/:id` (all) | safe (`assertProgramInScope`, then the item's own program); a body `eventDayId` must be the event's |
| `/program/:id` (GET, PUT, DELETE) | **fixed** (gated on the program's own event) |
| `/invites/:id` (GET, PUT, DELETE), `/:id/reactivate`, `/:id/resend` | **fixed** (`inviteInScope`; gated on the invite's own event) |
| `/invites/send`, `/invites/remind` (body `guestIds`) | safe (queried by the URL's event) |
| `/memory-hub/:id…`, `/memory-hub/:hubId/items…` | **fixed** in the wave 2 follow-ups |
| `/check-in/days/:dayId`, `…/guests/:guestId` (and an `inviteToken`) | safe (the day from the event's own days; guest and token looked up by event) |
| `/guests` create and import (body `eventDayIds`, the file's days) | safe (the event's own days) |
| `/announcements` (body `eventDayId`) | safe (one of the event's live days, else 422) |
| `/registration-settings` (body `openDayIds`) | safe (422 `REGISTRATION_SETTINGS_OPEN_DAY_UNKNOWN`) |
| `/feedback` (body `selectedPhotoIds`) | safe (the event's own eligible photos only) |
| `/pass/purchases/:purchaseId/reconcile` and the SMS bundle's | safe (looked up by id and event) |
| `/full` (every row id) | safe (matched against the event's own live rows, else that part's 404) |

`/api/guests/:id` has no event in its URL and goes through
`resolveEventScope` (see "The assignment lock").

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

**The assignment lock — one rule for every resource with assignments.**
For a locked role, a user with **no** assignments of a kind sees **every**
resource of that kind in their tenant; a user with **any** sees **only**
those. Anything else is a 404, the same as another tenant's record. It
only ever narrows what tenant scoping already allows; it never replaces
it. Written once, `createAssignmentLock`
(`shared/utils/assignment-lock.util.ts`), and instantiated per resource:

- **Events** (`event-assignment-lock.util.ts`): `EVENT_ADMIN` locked by
  `EventAssignment` rows. `TENANT_ADMIN` and `SUPER_ADMIN` are never
  locked. Enforced in exactly one place, `event.service.ts`'s
  `resolveEventScope`, which every event lookup (`getById`, `getScoped`,
  `getScopedWithPass`) and the list (`getAll`) goes through, and through
  those every event sub-resource: days, program, guests, invites, RSVP
  fields and responses, check-in, Memory Hub, Event Pass, tickets and
  purchases, invitation design, uploads. `/api/guests/:id`, which has no
  event in its URL, calls `resolveEventScope` directly. Never build an
  event `where` anywhere else.
- **Vendor spaces**, later: `EVENT_VENDOR` locked by `VendorSpaceUser`,
  through another `createAssignmentLock` call. This replaces the earlier
  vendor-visibility convention ("a member, or an unassigned space in their
  tenant") as the pattern for both spaces. Not switched over yet (vendors
  are off for the pilot): vendor spaces still enforce membership only
  (`getSpaceForViewer`), and services and products have the same gap.

The lock needs the signed-in user's id, which routers do not thread (they
pass `(role, tenantId)`). `authenticate` puts the viewer in a request
context (`shared/context/request-viewer.context.ts`, `AsyncLocalStorage`),
and the lock reads it there, so no call site can forget to pass it. It
supplies identity only; services still decide on the role and tenant they
are passed. **A locked role with no viewer fails closed**: a lookup 404s
and a list is empty. That covers a script or a test calling a service
directly (wrap it in `runAsRequestViewer`), and a callback API that loses
the async context. Node doesn't guarantee the context through stream-event
callbacks, so wrap one in `bindRequestViewer`, as the guest import route
does for multer (multer kept the context in testing; the bind is
insurance). A new callback-style middleware on an authenticated route
does the same, and gets a test as a locked member.

**Releasing the lock widens access.** Removing a user's **last**
assignment moves them from a few resources to all of them, so it is 409
`ASSIGNMENT_LOCK_RELEASE` unless the request carries `confirmWidening:
true` (`assertReleaseConfirmed`). A row for an archived resource still
counts as an assignment, so archiving someone's last event never widens
them either. A locked member who creates an event (direct create or the
wizard's materialize) is assigned to it in the same transaction.

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

**The share-link gallery is for anyone holding the link.** `GET
/api/memory-hub/:shareToken` (`memory-hub.service.ts`'s `viewByShareToken`)
reaches whoever the link was forwarded to, not only guests, so:
- **Only what the gallery page uses** (the frontend's
  `public-memories-page`): `eventName`, `isOpen`, `isCancelled` and the
  items, each `id`, `mediaUrl`, `mediaType` and `caption`
  (`toGalleryItem`). No hub title or description, no host name, no
  `createdAt` (the server orders them, newest first). A field the page
  starts showing is added then, not before.
- **No uploader name at all**, guest or organiser. Guest-view
  (`toPublicItem`) still shows a display name, to invited guests only.
- **A plan without Memory Hub answers as an unknown link.** The event's
  entitlement (an Event Pass included, `isMemoryHubTierEnabled`) is checked
  on every view; without Memory Hub it is the same 404 as an unknown,
  revoked or archived token, so a link holder learns nothing about the
  organiser's billing.
- **An archived event answers as an unknown link** too, from the moment it
  is archived (`findByShareToken` requires a live event), not only once its
  media is purged. Until 2026-10 the gallery kept serving an archived
  event's photos.
- **The 404 assumes no viewer:** "This link isn't active."
  (`INACTIVE_SHARE_LINK_MESSAGE`), never "ask the organiser".
- **Videos only while `memoryHubVideo` is on.**
- **600 requests / 5 minutes per IP** (`memoryHubGalleryLimiter`,
  `MEMORY_HUB_GALLERY_REQUESTS_PER_5_MIN`; it was 60). There is no
  per-person credential to key by, since every viewer holds the same
  token. The link is usually posted to a group chat at the event, so a
  whole room opens it at once on the venue Wi-Fi as one IP; one page open is
  one request (the photos come from Cloudinary), and 60 refused the 61st
  guest. A lower limit does nothing against scraping, since one response is
  the whole gallery; it only bounds load.

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
`MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN`). The same `limits` carry
what may be uploaded right now (`videosAllowed`, `videoMaxBytes`,
`allowedFormats`), so the picker never offers a file the signature refuses.

**Guest-view is limited per invite too** (`memoryHubGuestViewLimiter`, 60 /
5 minutes per invite, `MEMORY_HUB_GUEST_VIEWS_PER_INVITE_PER_5_MIN`, keyed
by the SHA-256 of the invite token; with no token, the IP through
`ipKeyGenerator`). It fires when a guest opens their page, and at the event
that is a whole room on the venue Wi-Fi at once; keyed by IP (60/5min, as
it was) the 61st guest's photo tab failed to load. The page asks once per
open, so 60 per invite leaves a household sharing one invite on several
phones far below it, and no guest less room than they had per IP. Its
backstop is its own `memoryHubGuestViewIpLimiter`: 100 **failed**
requests / 5 minutes per IP, `skipSuccessfulRequests`, for the same
made-up-token-per-request reason as the upload backstop, and never
sharing the upload limiters' budgets. **The guest's Program tab works the
same way** (`POST /api/rsvp/program`: `rsvpProgramLimiter`, 60 / 5 minutes
per invite, `RSVP_PROGRAM_VIEWS_PER_INVITE_PER_5_MIN`, keyed by the SHA-256
of the invite token; backstop `rsvpProgramIpLimiter`, 100 failed / 5
minutes per IP), for the same room-on-one-Wi-Fi reason, each with its own
budget.

Public self-registration has no credential before it succeeds, so it is
limited three ways: per **email** (5 an hour, keyed by the SHA-256 of the
normalised address, never the address: a repeat registration re-sends
that person's link, so this stops anyone flooding an inbox from many
IPs), per **IP** (500 per 15 minutes, `PUBLIC_REGISTRATIONS_PER_IP_PER_15_MIN`,
counting successes, since every success writes a guest and sends an
email), and per **event** (300 per 5 minutes,
`PUBLIC_REGISTRATIONS_PER_EVENT_PER_5_MIN`, a pace guard against a script
spread across many IPs). Both are sized for a company's staff registering
from one office network: a 300-person office in the first 15 minutes, at
about 1.5 attempts each (a mistyped address, a refused domain, a double
tap), is ~450 requests from one IP, front-loaded after one all-staff email
(~180 in the first five minutes, ~90 in the peak minute). The old 30 per 15
minutes refused the 31st colleague and 30 a minute refused the burst; a
5-minute window absorbs the burst while the sustained pace stays at 60 a
minute. What bounds a script's total is still the event's cap, its allowed
domains and the per-email limit. The per-email limiter's fallback for a
request with no email is the IP through `ipKeyGenerator`, like every other
IP key: **every custom `keyGenerator` that reads `req.ip` calls
`ipKeyGenerator` itself**, inline, so an IPv6 visitor can't step around a
limit by moving within their /56. express-rate-limit checks each
keyGenerator's own source for it when the limiter is created and logs
`ERR_ERL_KEY_GEN_IPV6` otherwise; that warning must never appear at
startup. Forgot password's per-email limiter (`forgotPasswordEmailKey`, 3
per 15 minutes) works the same way: the SHA-256 of the normalised email,
or for a request with no email its IP through `ipKeyGenerator`. A shared
fallback bucket (it used to be one `'unknown'` key for every email-less
request) lets one caller refuse everyone else.

**RSVP submit is limited per invite** (`rsvpSubmitInviteLimiter`, 20 an
hour, every request counted, keyed by the SHA-256 of the invite token).
It bounds how fast one invite can test addresses through the email-change
refusal (see "Guest contact"). Per invite and not per IP, for the shared-IP
reason above; 20 because a guest replies once and edits rarely, and the
frontend submits once per tap, never on its own.

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
`mediaUrl`; invitation designs and feedback logos were built with both
checks. An id
already stored on a record is not re-checked when re-sent unchanged.

### Email

**Every email is rendered by one layout,** `renderEmail`
(`shared/messaging/email-layout.ts`), and sent by the email engine
(`shared/messaging/email.engine.ts`): `sendEmail` for one message,
`sendEmailBatch` for many. Never call Resend directly, and never
hand-write email HTML.

**Guest sends are batched.** Invitations, reminders, announcements and
the cancellation email go through `sendEmailBatch`: Resend's batch
endpoint, up to 100 emails per call (`RESEND_BATCH_LIMIT`), one call after
another, never one email at a time. Each email is still its own message to
one guest, with their own link, From and Reply-To. Permissive validation:
an email Resend refuses fails alone, by its index, and the rest of its
batch goes. A batch call that is refused or throws fails exactly that
batch's emails, and the next batch still goes. Results come back one per
email, so every guest's success or failure is recorded exactly as before
(delivered, reminder log and cooldown, announcement delivery rows). SMS
still goes one at a time; a single resend, registration and auth emails
use `sendEmail`. A builder describes its message
as blocks of **plain text** (`seal`, `eyebrow`, `title`, `paragraph`,
`message`, `image`, `details`, `code`, `button`). `message` is an
organiser's own multi-line words (an announcement, a cancellation note):
left-aligned, escaped like everything else, its line breaks turned into
`<br>` only after escaping. The layout turns the same blocks
into the HTML part and the plain-text part, so the two always match.
`sendEmail` requires `text`, so no email leaves without a plain-text part.
Builders: `invite-message.util.ts` (invitation, reminder, registration,
announcement, cancellation),
`auth-email.util.ts` (sign-in code, password reset),
`user-invite-email.util.ts` (team invitation),
`feedback-request-email.util.ts` (the feedback request) and
`media-purge-reminder-email.util.ts` (an archived event's photos about to
be deleted).

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
link. Never write a domain into an email. The same goes for every other
link the server hands out (share links, payment callbacks):
`frontendUrl` is the only reader of `process.env.FRONTEND_BASE_URL`, and
a missing, blank or non-http(s) value stops the app at load
(`assertFrontendUrlConfigured` in `app.ts`), never an "undefined/…" link.

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
there is one. **The registration email** (public self-registration, see
"Public events and self-registration") is the same guest email: subject
"You're registered for <event>", eyebrow "You're registered", the days
the registrant said they'll attend, the same one button to their own
invite, and a footer saying they registered themselves. The same email
registering again gets **the re-send**: subject "Your link for <event>",
eyebrow "Here's your link again", a line saying the address was entered
again and that nothing changed if it wasn't them, the same button. Both
go through `inviteDispatchService.sendRegistrationEmail`, so their From,
Reply-To and design image are an invitation's.

**The announcement and cancellation emails** (see "Announcements") are
guest emails too, sent through `inviteDispatchService.sendGuestMessages`
with an invitation's From and Reply-To (`resolveReplyTo`). An
announcement: the organiser's subject as given (header-safe), the seal,
"A message from <host>", the event name, their body as a `message` block,
and the one "Open your e-velope" button to that guest's own invitation.
The cancellation email: subject "<event> has been cancelled", no seal, the
event name, its dates (every live day, labelled when several), the
organiser's note when there is one, and **no button**. A self-registered
guest gets the registration footer line on both.

**The design image** is shown only for an `UPLOAD` design, rewritten to an
explicit JPEG (`f_jpg,w_1200,c_limit`, displayed at 600px) with its alt
text. **Never `f_auto` in email**: image proxies fetch with their own
`Accept` header. A URL not in the Cloudinary `image/upload` shape is left
out, never sent as it is. TEMPLATE designs aren't shown in email.

**The team invitation** reads like an auth email (same From, no seal):
subject "You've been invited to join <company> on e-velope", one button
"Accept invitation" to `<FRONTEND_BASE_URL>/join?token=…`, its 7-day
validity, the ignore line. The company name goes through
`sanitizeDisplayName` on its way into the subject.

**The feedback request** (see "Feedback and sharing permissions") reads
like the team invitation: From `"e-velope" <RESEND_FROM_EMAIL>`, no seal,
subject "How did <event> go?" (the event name header-safe), one button
"Share your feedback" to `<FRONTEND_BASE_URL>/events/<id>/feedback`, and a
line that every permission is optional and can be changed later.

**The archived-media reminder** (see "Archived events: Memory Hub
retention") reads like the feedback request: the same From, no seal,
subject "Photos from <event> will be deleted on <date>" (the event name
header-safe, the date UTC through `formatGuestDate`), a line that the event
is archived and its Memory Hub photos and videos will be permanently deleted
on that date, a line to download them first (the event, its cover and its
invitation design are kept), and one button "Download your photos" to
`<FRONTEND_BASE_URL>/events/<id>/manage/memories`.

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

Seven documented exceptions:

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
- The append-only send logs `SmsSendLog`, `InviteReminderLog`,
  `Announcement`, `AnnouncementDelivery`, `EventEmailClaim`,
  `FeedbackRequestClaim` and `MediaPurgeReminderClaim` — a message was sent, or failed to be, recorded
  once and never edited or archived. An `Announcement` is
  written when its send is claimed, so its failure count is summed from
  its delivery rows at read time, never written back onto it.
- `ConsentRecord` — every permission given or withdrawn, append-only like
  the ledger: no `isArchived`, no `updatedAt`, no update or delete method
  in `consent.repository.ts`, and the database refuses an `UPDATE` of a
  row (the `ConsentRecord_no_update` trigger). Withdrawing is a new record.
  See "Feedback and sharing permissions".
- Membership join rows, `VendorSpaceUser` and `EventAssignment` — "this
  person is on this space/event" is a current fact, set and unset as a
  whole; removing a membership deletes the row. The person and the
  resource are each archived (or suspended) on their own.

`EventDraft` is a record that stopped mattering once consumed;
`PaymentLedgerEntry` and the logs record something that happened, which does
not stop having happened. A correction is a NEW entry, never an edit to an old one. What a tenant
has earned, whether a subscription is current, etc. are all summed from
entries at read time — there is no balance column to instead mark
`isArchived` on, and none should be added.

**Files are the one thing deleted, and only one kind.** An archived event's
Memory Hub photos and videos are deleted from Cloudinary 30 days after it
was archived (see "Archived events: Memory Hub retention"). Their
`MemoryItem` rows stay, marked `purgedAt` and archived; the purge itself is
recorded (`EventMediaPurge`, kept, written only while it runs). No other
file is deleted for retention: covers, invitation designs and feedback
logos stay, and a live event's media is never purged.

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

An event restored after its Memory Hub media was purged comes back without
it, and a purged item can't be restored (409): its file is gone.

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
| 429 | A product limit on how often (announcements per event per day), always with a code |

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

One single code: `USER_EMAIL_TAKEN` (`POST /api/users`, 409, "A user
with this email address already exists. Use a different email
address."): the admin form marks the email field rather than showing a
banner. The same code covers the database's own unique-email error when
two creations race past the check (`isUniqueViolationOn`,
`shared/utils/prisma-error.util.ts`: never a 500), and an address that
already has an account on team invitation create, resend and accept
(the accept message tells the person to sign in instead). Email uniqueness is platform-wide, so this tells a `TENANT_ADMIN`
that an address has an account somewhere, possibly in another tenant.
The status already told them that before the code existed (500 instead
of 201); the code adds nothing to it. Accepted for now, not designed.

Team members: `ASSIGNMENT_LOCK_RELEASE` (`PUT /api/users/:id/assignments`,
409; see "The assignment lock" under Tenant scoping), `TEAM_INVITE_PENDING`
(`POST /api/users/invites`, 409, vs `USER_EMAIL_TAKEN`: resend the open
invite instead), and on `POST /api/team-invites/lookup` and `/accept`:
`TEAM_INVITE_INVALID` (404 — unknown, revoked, or the workspace is
suspended; told apart from a route 404), `TEAM_INVITE_EXPIRED` (422, vs a
blank name), `TEAM_INVITE_USED` (409, vs `USER_EMAIL_TAKEN`). An accept
signed in with a different email is a plain 403. Unknown and revoked are
deliberately one code.

Another single code: `OTP_SEND_FAILED` (`POST /api/auth/request-otp`, 503,
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
+27825551234"), and a guest removing their only contact. With `sms` off,
a guest removing their email (or swapping it for a phone) is 422
`GUEST_EMAIL_REQUIRED`. Changing to an email the guest can't have (another
guest on the event has it) is 422 `CONTACT_EMAIL_UNAVAILABLE`, "That
email address can't be used for this invitation. Please use another
one.", one message and code for every cause (see "Guest contact"). A
phone is never refused for being another guest's. The two phone
codes are set by `normalizePhoneToE164` (`guest-validation.util.ts`), so
organiser guest create and import carry them too, still as 400.

Public self-registration (`POST /api/public-events/:shareToken/register`)
tells the registration page which state to show:
`REGISTRATION_EVENT_CANCELLED` (410), `REGISTRATION_CLOSED` (410: the
closing date or RSVP deadline passed, the event is over or not yet open,
or no day is open to registration), `REGISTRATION_FULL` (409: the cap, or
the plan's guest limit, never named to a registrant),
`REGISTRATION_PARTY_TOO_LARGE` (409, vs FULL: room left, but not for this
many plus-ones; the form marks the plus-ones) and
`REGISTRATION_EMAIL_DOMAIN` (422, the email field; also at RSVP submit,
see "Public events and self-registration"). The rest of the
form's 422s say which field: `REGISTRATION_TOO_MANY_PLUS_ONES` (more than
the organiser allows each registrant, vs PARTY_TOO_LARGE),
`REGISTRATION_DAY_NOT_OPEN`, and `REGISTRATION_FIRST_NAME_TOO_LONG`,
`REGISTRATION_SURNAME_TOO_LONG`, `REGISTRATION_PLUS_ONE_NAME_TOO_LONG`,
`REGISTRATION_FIRST_NAME_REQUIRED`, `REGISTRATION_EMAIL_INVALID`,
`REGISTRATION_NO_DAYS_CHOSEN` (an empty `dayIds`) and
`REGISTRATION_PLUS_ONE_NAME_REQUIRED`. A missing email is 422
`GUEST_EMAIL_REQUIRED`, and a bad phone carries the contact codes, as at
RSVP. Only a malformed body (a wrong type) is an uncoded 400. A phone
another guest already has is never a refusal. A self-registered
guest whose RSVP edit asks for more seats than the cap has left gets 409
`REGISTRATION_FULL` too. `REGISTRATION_CLOSED` covers several causes; the
view's and the settings' `registration.code` says which (see "Public events
and self-registration").

Answers to the event's own questions, at RSVP submit and at registration
alike (`rsvp-answers.util.ts`, one helper for both): `RSVP_ANSWER_REQUIRED`
(422, a required question left blank by someone attending: "Please answer
'Dietary needs'. The organiser needs this to plan for you."),
`RSVP_ANSWER_INVALID` (422, not its question's type: EMAIL, PHONE, NUMBER,
a DROPDOWN answer that isn't one of its options, "Choose one of the
options for 'T-shirt size'.", or a CHECKBOX answer other than exactly
"true" or "false", "Tick the box for 'Need parking', or leave it
unticked."; a blank answer is no answer),
`RSVP_ANSWER_DUPLICATE` (422, the same question answered twice in one
submission; checked first, it was a 500 from the unique
`(inviteId, rsvpFieldId)` index) and `RSVP_ANSWER_UNKNOWN_FIELD` (400, a
question this event doesn't have, archived ones included). Until 2026-10
all of these were uncoded at RSVP.

An answer is stored exactly as sent and returned as stored (the guest page's
`rsvpResponses`, the organiser's guest details, the export); the backend
never fills one in. A CHECKBOX the form didn't send stores nothing and
comes back as no answer; "false" is stored only when sent. Whether the
form sends "false" for a box the guest never touched is the frontend's
choice (`answersToSend`): until 2026-10 it sent nothing unless the box had
been ticked and then cleared, so the same "no" was stored two ways (as
"false", or as no answer at all).

Registration settings (`PUT /api/events/:eventId/registration-settings`):
every 422 carries a code, one per refusal, named for its field
(`REGISTRATION_SETTINGS_ERROR_CODES`, `registration-settings.service.ts`):
`REGISTRATION_SETTINGS_DOMAIN_INVALID`,
`REGISTRATION_SETTINGS_TOO_MANY_DOMAINS`,
`REGISTRATION_SETTINGS_CAP_INVALID`,
`REGISTRATION_SETTINGS_CAP_ABOVE_PLAN_LIMIT`,
`REGISTRATION_SETTINGS_CLOSES_AT_INVALID`,
`REGISTRATION_SETTINGS_CLOSES_AT_AFTER_DEADLINE`,
`REGISTRATION_SETTINGS_PLUS_ONES_INVALID`,
`REGISTRATION_SETTINGS_OPEN_DAY_UNKNOWN` and
`REGISTRATION_SETTINGS_NO_OPEN_DAYS`. A wrong type (400) and a cancelled
event (409) have none. Plus-ones per registrant is 0 to 20, the guest
rule below.

The plus-ones allowance (guest create, update and import, and the
registration settings' per-registrant one) is a whole number from 0 to 20
(`MAX_PLUS_ONES_ALLOWED`, `guest-validation.util.ts`). Anything else is
422 `GUEST_PLUS_ONES_INVALID` ("Plus-ones allowed must be a whole number
from 0 to 20."), a refused row on import, or
`REGISTRATION_SETTINGS_PLUS_ONES_INVALID` in the settings, never a value
that reaches the integer column and comes back a 500.

`GUEST_EMAIL_TAKEN` (409, "Another guest on this event already has this
email address."): an organiser adding a guest (`POST
/api/events/:eventId/guests`) with, or changing one (`PUT /api/guests/:id`)
to, an email another guest on the same event has; restoring an archived
guest whose email a live guest now has; and the database's own unique
index on a guest's email, on those paths and import (see "Guest
contact"). A plain message, unlike RSVP's neutral
`CONTACT_EMAIL_UNAVAILABLE`: the organiser can see their own guest list, so
it tells them nothing new.

`PLUS_ONES_OVER_ALLOWANCE` (`POST /api/rsvp/submit`, 422, "You can bring up
to N plus-one(s)…"): more plus-ones named than the guest's own allowance;
the form marks the plus-ones. It was an uncoded 400.

Announcements (`/api/events/:eventId/announcements`, see "Announcements"):
every 422 carries a code naming its field (`ANNOUNCEMENT_ERROR_CODES`,
`announcement.service.ts`): `ANNOUNCEMENT_SUBJECT_REQUIRED`,
`ANNOUNCEMENT_SUBJECT_TOO_LONG`, `ANNOUNCEMENT_BODY_REQUIRED`,
`ANNOUNCEMENT_BODY_TOO_LONG`, `ANNOUNCEMENT_AUDIENCE_INVALID`,
`ANNOUNCEMENT_DAY_INVALID`, and `ANNOUNCEMENT_NO_RECIPIENTS` (nobody in the
audience has an email). The daily limit is 429
`ANNOUNCEMENT_DAILY_LIMIT`, "You've sent the most announcements allowed in
24 hours. Try again later.": no clock time, because the server could only
write UTC. The frontend shows when the next one can go, in the organiser's
own time zone, from the history's `dailyLimit.nextAvailableAt`.
Cancelling with a note over 1000 characters is 422
`CANCELLATION_NOTE_TOO_LONG` (`POST /api/events/:id/cancel`), and
cancelling an event whose last day has passed is 409
`EVENT_ALREADY_HAPPENED` (vs the uncoded 409 for one already cancelled). A wrong type
(400) and a cancelled event (409) have none.

`MEMORY_HUB_VIDEO_UNAVAILABLE` (422): a Memory Hub upload signature for a
video while `memoryHubVideo` is off, on the organiser path (`POST
/api/uploads/signature`, purpose `MEMORY_ITEM`) and the guest path (`POST
/api/memory-hub/guest-upload-signature`, "Videos can't be added to this
photo album right now. You can still add photos."). The uploader tells the
person to pick a photo; any other 422 there is a bad file.

Before any route (`body-parse-errors.middleware.ts`, mounted right after
the body parsers): a body that isn't valid JSON is 400 `MALFORMED_JSON`
("The request body isn't valid JSON."; the parser's own message quotes
the body and is never sent); a JSON or URL-encoded body over the parsers'
10MB limit (`REQUEST_BODY_LIMIT_MB`) is 413 `REQUEST_TOO_LARGE` ("The
request is too large. It must be 10MB or smaller."); and a browser origin
that is neither the frontend's own (`FRONTEND_BASE_URL`'s origin, always
allowed) nor in `ALLOWED_ORIGINS` is an uncoded 403. All three used to be 500s
reported to Sentry; none is reported now.

System health (`GET /api/admin/system/errors`, super admin only):
`SENTRY_NOT_CONFIGURED` and `SENTRY_UNAVAILABLE` (both 503: fix the
server's configuration, or wait and retry). See "Error monitoring".

Safety limits (see "Safety limits" under Domain rules): venue capacity
outside 1 to 100,000 is 422 `EVENT_CAPACITY_INVALID` (event create, update
and the wizard's materialize); a guest past the 5,000-per-event ceiling is
422 `EVENT_GUEST_CEILING` for an organiser (add, import, restore), while a
registrant or an RSVP gets registration's own `REGISTRATION_FULL` /
`REGISTRATION_PARTY_TOO_LARGE`, never the number; an import file of more
than 2,000 rows is 422 `GUEST_IMPORT_TOO_MANY_ROWS` and one over 5 MB is 413
`GUEST_IMPORT_FILE_TOO_LARGE`; invitation and reminder emails past the
event's daily allowance are 429 `EVENT_EMAIL_DAILY_LIMIT`.

Guest import, a file that can't be read: 422 `GUEST_IMPORT_UNREADABLE_FILE`,
"We couldn't read this file. Save it as .xlsx or .csv and try again." (a
file named .xlsx that isn't a workbook, a damaged one, one exceljs still
throws on, one that unpacks past 3 MB in any part or 4 MB in all, or a
CSV the parser refuses), never a 500. Was a 500 for a
workbook and an uncoded 400 with the parser's own words for a CSV. A file
that is neither .xlsx nor .csv stays an uncoded 400.

Memory Hub download (`POST /api/events/:eventId/memory-hub/download`): 422
`MEMORY_HUB_NOTHING_TO_DOWNLOAD` (no approved items) and 429
`MEMORY_HUB_DOWNLOAD_RATE_LIMIT`.

The plan's active-event limit: 403 `EVENT_LIMIT_REACHED`, on creating an
event (`POST /api/events`, the wizard's materialize) and on restoring an
archived one (`POST /api/events/:id/reactivate`, "Archive another of its
events, then restore this one."), told apart from the other tier 403s. It
was uncoded until 2026-10. Archived-event media (see "Archived events:
Memory Hub retention"), `POST /api/admin/events/:eventId/media-purge`: 409
`EVENT_NOT_ARCHIVED` (a live event's media is never purged) and 409
`MEDIA_PURGE_ALREADY_STARTED` (this archiving's purge has begun or
finished; the message says which), and 422 `ARCHIVE_MEDIA_PURGE_OFF` while
`archiveMediaPurge` is off, checked first. Restoring a purged Memory Hub
item is an uncoded 409. A guest upload (signature or save) to an archived
event's album is an uncoded 404, "This photo album isn't available.", the
same words whatever the cause behind it, never "archived". The guest's
invitation for an archived event (RSVP validate, submit, ticket quote) is an
uncoded 410, "This event is no longer available.", like an expired link's
410 and with nothing to tell apart for the page: both show the message.

Dates on days and program items (see "Event days and program items"):
a new or changed day date before UTC today minus one day is 422
`EVENT_DAY_DATE_IN_PAST` ("The date of '<label>' has already passed. Choose
today or a later date."; day create and update, the wizard's materialize
and the full event update), and a program item whose start isn't on its
day's UTC date is 422 `PROGRAM_ITEM_DATE_NOT_ON_DAY` ("'<title>' is set to
'<day>', so it must start on <date>. Change its start date or choose
another day."; item create and update, materialize and the full update).
The full event update (`PUT /api/events/:eventId/full`) has no codes of its
own: every refusal is its part's own endpoint's, code included.

Values that used to reach Prisma unchecked as a 500 (all 422):
`RSVP_FIELD_OPTIONS_INVALID` ("The choices for '<label>' must be a list of
text options.": a question's `options` that isn't a JSON-encoded list of
strings, which is what the RSVP page reads; POST/PUT `.../rsvp-fields`, the
full update, and the wizard's materialize, whose draft holds the choices as a
list and stores its JSON), `MEMORY_HUB_OPENS_AT_INVALID` ("The Memory Hub's opening
time isn't a valid date and time.": null or `''` is "open now", anything
else must parse; POST/PUT `.../memory-hub`, the wizard's materialize and the
full update) and `PROGRAM_VISIBILITY_INVALID` ("Program visibility must be
true or false."; PUT `.../program/:id`, materialize and the full update).

Feedback (`PUT /api/events/:eventId/feedback`, see "Feedback and sharing
permissions"): every 422 carries a code naming its field
(`FEEDBACK_ERROR_CODES`, `feedback-validation.util.ts`):
`FEEDBACK_EVENT_NOT_COMPLETED` (also on the logo signature),
`FEEDBACK_SCORE_INVALID` (missing on the first save, or not a whole number
0–10), `FEEDBACK_WORKED_BEST_TOO_LONG`, `FEEDBACK_TO_IMPROVE_TOO_LONG`,
`FEEDBACK_PHOTO_NOT_ELIGIBLE`, `FEEDBACK_LOGO_INVALID` and
`FEEDBACK_LOGO_TOO_LARGE`. A wrong type (400) and a `SUPER_ADMIN` saving
(403) have none. A guest asking to share a video publicly (`POST
/api/memory-hub/guest-items` and the public-sharing toggle) is 422
`PUBLIC_SHARING_PHOTOS_ONLY`.

Terms of Service (see "Terms of Service" under Non-negotiable rules):
`TERMS_NOT_ACCEPTED` (403, "Please accept the Terms of Service to
continue."), from every authenticated route except the exempt ones until
the caller has accepted the current version; the client shows the Terms,
it doesn't sign anyone out. Told apart from the uncoded 403 for an
inactive account. And `TERMS_VERSION_MISMATCH` (`POST /api/terms/accept`,
409): the version sent isn't the current one, because the page showed older
Terms; reload them. A missing or non-text `version` is an uncoded 400.

`EVENT_HOST_NAME_REQUIRED` (422, "Add the host's name. Guests see it on
their invitation."): event create, `PUT /api/events/:id`, the full update
and the wizard's materialize (see "Host name" under Domain rules). Checked
last on each, so any other refusal and its code comes first. A host name
over 200 characters stays the uncoded 422 it was.

`TENANT_SLUG_INVALID` (`POST /api/auth/register`, 422): a typed
organisation address that isn't lowercase letters, numbers and single
hyphens, up to 60 characters; the form marks the address field. A taken
one is never refused (see "Sign-up: the organisation address"); a
non-text `tenantSlug` is an uncoded 400.

A code must never subdivide a case that is already deliberately generic
for security reasons. `DEVICE_NOT_RECOGNISED` covers missing, wrong,
wrong-user, revoked, **and** expired device tokens — one code, matching
the one message already used for all of them — because splitting those
apart is exactly the oracle the single message exists to avoid.
`FIREBASE_TOKEN_INVALID` is safe to keep as its own code precisely
because whoever holds a Firebase ID token can already check its
validity directly with Firebase; there's nothing to leak.

### Error monitoring

**Sentry, permanent infrastructure, not a feature:** no flag. On when
`SENTRY_DSN` is set; without it nothing is initialised and nothing is sent.
`src/instrument.ts` is `server.ts`'s **first import**, so Sentry starts
before the app loads (keep it first). Environment from
`SENTRY_ENVIRONMENT` (falls back to `NODE_ENV`), release from
`RENDER_GIT_COMMIT`. All of it lives in `src/shared/monitoring/`.

**What is reported:** every unexpected error and every 5xx, an `HttpError`
503 included. **An `HttpError` below 500 never is**: a 404, 409, 422 or 429
is the app working as designed. One rule decides, `shouldReportError`
(`error-reporting.ts`); the global handler calls `reportError` for every
error it sees, and a handler that sends a 5xx itself is caught by the
`reportUnreportedServerErrors` safety net (or calls `reportError` with the
exception, as the Paystack webhook does). A deliberate, explained 5xx (the
system health endpoint's 503) calls `skipServerErrorReport`. Uncaught
exceptions and unhandled rejections are captured by Sentry's own handlers
and flushed before the process exits. **Tracing is off**: errors are what
we need, Render shows latency, and a span would carry URLs and query text
past the scrubber and spend the quota. Turn it on only for a specific
performance question, at a very low rate.

**Privacy rules for error data.** Error data leaves our infrastructure, so
every event and breadcrumb goes through one scrubber (`sentry-scrub.ts`,
wired as `beforeSend`/`beforeBreadcrumb`), and most of it is never
collected in the first place: Sentry v11's `dataCollection` defaults to
collecting everything (cookies, headers, bodies, query strings, user info,
local variables), so `sentry.config.ts` switches every category off, and
`maxRequestBodySize: 'none'` keeps the body out of the HTTP integration
too. Never sent: request bodies, cookies, query
strings, any header outside a short allowlist (`Authorization` and
`X-Session-Token` included), device and session tokens, invite, share and
team-invite tokens (in a URL path too: `/rsvp/validate/:token` is masked),
oobCodes, OTP codes, passwords, and **any email address or phone number
anywhere** (message, URL, exception text, breadcrumb, extra, tags), all
masked. A JSON parse error's message is withheld whole, since it quotes the
body (a malformed request body is now a 400 and never reported; the rule
stays for any other parse error). The user is `id`, `role` and `tenantId`, never email, name or phone.
A new kind of credential is a new scrubber rule and a new value in
`tests/monitoring/sentry-scrub.test.ts`, never "it won't be logged".

**System health** (`GET /api/admin/system/errors?environment=&project=&status=`,
`src/modules/system-health/`): `SUPER_ADMIN` only, and everyone else gets
the global 404 (`requireSuperAdminHidden`), not a 403. It reads Sentry's
API with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECTS`
("`<backend slug>,<frontend slug>`", in that order; `SENTRY_API_URL`
optional, defaulting to the DSN's region, e.g. `https://de.sentry.io`), and
returns both projects' issues merged, newest activity first, unresolved
unless `status` says `resolved` or `ignored`: `title`, `project`
(`backend`/`frontend`), `environment` (the filter, or `null` when the list
spans every environment: Sentry's list doesn't name one per issue),
`level`, `count`, `usersAffected`, `firstSeen`, `lastSeen`, `status`,
`link`. With it, `health`: the deployed `commit`, `environment`,
`uptimeSeconds`, `startedAt` and whether the database answers. Each answer,
a failure included, is **cached 60 seconds** per filter, so the screen
can't exhaust Sentry's API limits. Sentry not configured is 503
`SENTRY_NOT_CONFIGURED`; Sentry failing, timing out or refusing is 503
`SENTRY_UNAVAILABLE`; never a 500. Both 503s still carry `data.health`.
**The auth token never leaves the server**: not in a response, a log line
or an error message.

### Tier enforcement

Subscription limits are enforced **server-side**. Frontend gating is UX,
never the security boundary — for a period the frontend was the only
gate in the system and the API could be called directly to bypass it.

Read limits from `SubscriptionTierConfig` at runtime. Never hardcode
them; a `SUPER_ADMIN` can change them and enforcement must follow.
`null` means unlimited.

Enforcement points differ: `maxGuestsPerEvent` is checked whenever a live
guest is **added** (organiser add, import, and restoring an archived guest,
a plus-one excepted since the limit doesn't count them), under the event's
row lock so two at once can't both take the last place;
`maxSmsPerMonth` at **send time**, all-or-nothing. A plan's limit is
never the last word: the hard limits under "Safety limits" (Domain rules)
apply after it, whatever a `SUPER_ADMIN` sets, `null` included.

**No feature is tied to a tier by name in code.** Every paid-only feature
is a `SubscriptionTierConfig` setting a `SUPER_ADMIN` can switch on for any
tier, the free one included: `memoryHubEnabled`, `guestExportEnabled`,
`vendorMarketplace`, `smsEnabled` (already settings), and
`publicEventsEnabled`, `paidTicketingEnabled`, `customRsvpFieldsEnabled` and
`vendorPriorityPlacement` (`tier-capabilities.util.ts`; they were Spark-
and Elevate-by-name until the free pilot). Their migration set every tier
to what the code did before. A tier with **no config row** keeps that old
rule for these four rather than switching them off, so a database the
seed never reached behaves as before. A new paid-only feature is a new
setting, never a tier name in an `if`.

**The frontend decides from settings, never from the plan's name.**
`GET /api/tenants/me` carries `planSettings`: the limits (`maxEvents`,
`maxGuestsPerEvent`, `maxSmsPerMonth`, `maxVendorSpaces`,
`maxMemoryHubBytesPerEvent`, `null` = unlimited) and the on/off settings
(`smsEnabled`, `memoryHubEnabled`, `guestExportEnabled`,
`vendorMarketplace`, `publicEventsEnabled`, `paidTicketingEnabled`,
`customRsvpFieldsEnabled`, `vendorPriorityPlacement`) of the tenant's
effective plan. One function resolves them, `resolvePlanSettings`
(`plan-settings.util.ts`), with exactly the server's fallback when the
tier has no config row; change an enforcement point's fallback and it
changes too. A setting of a switched-off feature is left out, not sent as
false. Whether to show, lock or badge a feature comes from these;
`subscriptionTier` is for display (the plan's name on a billing screen)
and is never compared in code. They are the tenant's plan: an event's own
numbers, which an Event Pass can raise, come with the event (its
`guestLimit`).

**A new tier column needs a per-tier `UPDATE` in its migration.** `null` on a
numeric limit means unlimited, so a migration that only does `ADD COLUMN`
leaves every existing row unlimited — it fails **open**. Follow the `ADD
COLUMN` with an `UPDATE "SubscriptionTierConfig" SET … WHERE "tier" = …` for
each tier, and update `TIER_CONFIGS` in `prisma/seed.ts` to match. The seed
cannot cover for you: it never touches a database it isn't pointed at, and it
does not overwrite existing tier configs. `maxMemoryHubBytesPerEvent` (bytes) is a `BIGINT`, so a limit can be above
2 GB (`20261017090000_memory_hub_bytes_bigint`); Prisma reads it as a JS
`bigint`, and `subscription-tier-config.repository.ts` hands every row on
with it as a plain number (a `bigint` can't be written to JSON). Read tier
configs only through that repository. The tier admin takes it, and
`guestExportEnabled`, with the other limits and switches: a whole number of
0 or more within JavaScript's safe-integer range (or null), and true or
false, else 422. `maxVendorSpaces` and
`maxMemoryHubBytesPerEvent` were both added without one, so on any database
the seed has never run against they are `null`, i.e. unlimited. There is no
production database yet, so nothing is broken today — the first one must be
populated by hand.

**While `payments` is off there is no upgrade path** (see "Feature
flags"): tier refusals carry free-trial wording and the contact address,
never a plan or a price.

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

Whether a feature is locked at all is read from `/me`'s `planSettings`
(above), never from the plan's name.

- **Signed-in tenant, tenant-scoped feature** (Vendor Space, Vendor
  Discovery). A locked click, or a direct URL hit, raises a confirmation
  — nobody is moved somewhere unannounced — and confirming goes to
  `/subscription`, carrying the reason as the `feature` query param only.
  There is no `requiredTier` param: no plan is named, since the gate is
  read from `planSettings` and any tier can have the setting switched on.
  A direct hit lands on the dashboard with that confirmation open. With
  `payments` off it shows the free-trial wording and contact address instead,
  and confirming goes nowhere. (`TierGateService`, `tierGuard`.)
- **Signed-in tenant, event-scoped feature** (Memory Hub, which an Event
  Pass on that event also unlocks). No confirmation: the user goes to the
  event's Control Center with `?upgrade=<feature>`, which opens a
  two-option prompt — subscribe (`/subscription`), or unlock just this
  event with an Event Pass. (`eventTierGuard`.)
- **Logged-out visitor.** The public `/pricing` page is a marketing
  surface for them, and only them.

Exception: registration-time tier selection is not an upsell surface —
nobody is upgrading before they have an account.

### Feature flags

Production can run a reduced feature set while dev keeps everything. One
codebase: a feature is switched off by configuration, **never deleted**.

- **Every new optional feature registers a flag** in the one registry,
  `FEATURE_NAMES` (`src/shared/features/feature-flags.ts`), under a
  stable name. Today: `vendors`, `ticketing`, `sms`, `wallet`,
  `settingsPage`, `invitationDesigns`, `teamMembers`, `publicEvents`,
  `announcements`, `payments`, `memoryHubVideo`, `memoryHubDownload`,
  `feedback`, `archiveMediaPurge`.
- **Configured by `FEATURES_DISABLED`**, a comma-separated list of names
  (e.g. `vendors,ticketing,sms,wallet,settingsPage,invitationDesigns`).
  Unset means everything is on. An unknown name stops the app at load
  (`assertFeatureConfigValid` in `app.ts`); it is never ignored. Names are
  case-sensitive.
- **Routes are guarded on the server**, with one `requireFeature(name)`
  (`shared/middleware/feature.middleware.ts`) per router or route: after
  `authenticate`, before the role gate. Never as checks scattered through
  services. Off means a 404 with the global 404 body, for everyone except
  `SUPER_ADMIN`, the way a role gate hides. On a public route, off is a
  404 for everyone.
- **A shared path belongs to the feature it serves, not to whatever it
  touches.** The Paystack webhook, subscriptions and Event Pass use
  Paystack but are not ticketing; only the ticket routes and the payout
  bank-details (subaccount) routes are. Subscriptions, Event Pass and SMS
  bundle purchases belong to `payments`; the webhook belongs to nothing
  and is never switched off.
- **Beyond its routes, a switched-off feature can't be reached by any
  other path.** Every refusal is a 422 checked BEFORE any tier check, so
  a tenant never hears an upgrade pitch for a feature that isn't on offer:
  - `ticketing` off: `/rsvp/validate` offers no tickets, an RSVP carrying
    a `ticketId` is refused, and no path makes an event paid: create,
    update FREE → PAID, the wizard's materialize, and publishing a draft
    saved as paid.
  - `publicEvents` off: no path makes an event `PUBLIC`, the same way.
    The public view, registration, share links and
    `/api/events/:eventId/registration-settings` are 404.
  - **Only a change is refused.** Saving an event that is already paid or
    public, re-sending the stored value or leaving it out, succeeds, so
    older events stay editable. Past that check the switched-off value is
    kept out of the tier and payout checks, so the save isn't refused for
    a plan or for missing bank details either.
  - `vendors` off: an `EVENT_VENDOR` user can't be created, and
    `/api/tenants/me` has no `vendorSpaceLimit`.
  - `sms` off: nothing is texted; an SMS-only guest on a send, resend or
    reminder is a per-guest failure the organiser sees, never a silent
    skip. The guest import template asks for an email for every guest and
    its examples are emails. Nobody ends up reachable only by phone: phone-only is 422 on
    guest create, and on an update that changes the contact (an update
    that leaves the contact alone, a name or the plus-ones, is never
    refused for it, so a phone-only guest from before the switch stays
    editable) (public self-registration needs an email
    whatever the flag says: the link is emailed), phone-only
    rows are refused and listed on import while the rest imports, and at
    RSVP a guest who has an email can't remove it or swap it for a phone
    (adding a phone beside it is fine; a guest who never had an email can
    still reply).
  - `invitationDesigns` off: `/rsvp/validate`'s `design` is `null` and
    emails carry no design image.
  - `teamMembers` off: `/api/users` (team management, assignments,
    invitations) and `/api/team-invites` are 404. Members already added,
    their assignments and the assignment lock carry on unchanged.
  - `announcements` off: `/api/events/:eventId/announcements` is 404, and
    cancelling an event emails nobody (`guestNotification: null`); the
    cancel itself works as before.
  - `payments` off (the free launch pilot; switched back on when billing
    returns): every route that starts or changes a payment is 404:
    `/api/subscriptions` subscribe, change-tier, cancel and
    update-card-link, and `/api/events/:eventId/pass` purchase, SMS bundle
    purchase and both reconciles. The Paystack webhook keeps working, so a
    payment started before the switch still lands, and so do the read-only
    routes (current plan, plans, billing history, pass status). Every tier
    refusal is then worded without plans, tiers, passes, upgrading, buying
    or prices, with free-trial wording and the contact address instead
    ("You've reached the limit of 3 active event(s) during your free trial.
    Archive an event you no longer need, or contact us at
    admin@e-velope.co.za if you need more.";
    "Public events aren't available during your free trial. Contact us at
    admin@e-velope.co.za if you need them."), keeping its status and code.
    One place picks the wording: `tierRefusalMessage`
    (`subscription-tier-config/tier-refusal-wording.util.ts`); a new tier
    refusal goes through it.
  - `memoryHubVideo` off: no Memory Hub upload signature for a video,
    organiser or guest (422 `MEMORY_HUB_VIDEO_UNAVAILABLE`), and guest-view's
    `limits` say so (`videosAllowed: false`, `videoMaxBytes: null`,
    `allowedFormats` images only). Videos already uploaded stay and show
    to the organiser and in guest-view, and are left out of a Memory Hub
    download and the share-link gallery.
  - `memoryHubDownload` off: `POST /api/events/:eventId/memory-hub/download`
    is 404. Nothing else changes.
  - `feedback` off: `/api/events/:eventId/feedback`, `/api/admin/feedback`
    and the guest's public-sharing toggle are 404; a guest upload's
    `allowPublicSharing` is ignored (nothing recorded, and the upload goes
    through); guest-view has no `publicSharing`; the feedback request sweep
    sends nothing (an event asked later still gets its one email, while
    inside the window). Consent records already given stay.
  - `archiveMediaPurge` off (see "Archived events: Memory Hub retention"):
    the retention sweep does nothing (no reminder, no new purge, no retry of
    one begun), the super admin purge is 422 `ARCHIVE_MEDIA_PURGE_OFF` (the
    route only answers a super admin, who a flag never hides from, so the
    refusal is in the service), and events report no `mediaPurgeAt` unless
    a purge had already begun. Archiving still records `archivedAt`, and an
    archived event is still private to its guests: the flag is about
    deleting, not hiding. Switched back on, nothing is deleted at once: an
    overdue event is reminded first and purged a week later.
  Tier messages and limits never name a switched-off feature to a tenant.
- **The frontend reads `GET /api/config/features`** (public, no auth,
  `{ status: 'ok', data: { vendors: true, … } }`) and keeps no copy of the
  flags. Frontend hiding is UX; the server guard is the boundary.
- **Switching a flag off never deletes data.** Saved designs, tickets,
  vendor spaces and the rest stay exactly as they were; they are only not
  served. Switching it back on brings them back unchanged.

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
with a **401 that carries no code** ("Your sign-in has expired or is not
valid. Please sign in again."). That endpoint's only coded 401s are `SESSION_EXPIRED` and
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

### Terms of Service

**Every account must have accepted the current Terms of Service before
using e-velope.** The current version is `TERMS_VERSION`
(`src/modules/terms/terms.service.ts`, a date string: `"2026-11-01"` at
launch, now `"2026-10-30"`, the Terms of Service and Privacy Policy as
updated after legal review). Until a user has accepted that exact version, **every
authenticated route answers 403 `TERMS_NOT_ACCEPTED`**, super admins
included. The check lives in `authenticate` itself
(`auth.middleware.ts`, read in the same query as the user), so a new
route gets it without doing anything: it fails closed.

The only authenticated routes that skip it use
`authenticateAllowingPendingTerms` instead, and must stay this short list:

| Route | Why |
|---|---|
| `GET /api/terms/status`, `POST /api/terms/accept` | how the person accepts |
| `GET /api/tenants/me` | the app reads it right after sign-in, before it can show the Terms |

`/api/auth/*` (session exchange, refresh, sign-out, and register, OTP and
forgot-password) and `/api/config/features` never call `authenticate`, so
they are never blocked either. Don't add a route to the exempt list
without a reason a person who hasn't accepted needs it.

**Who it covers:** new sign-ups (registering creates the account; its
first authenticated request is a 403 until they accept), team members
joining through an invitation (the same), and every existing user, on
their next visit. **Guests are not accounts** (RSVP, public registration,
Memory Hub guest routes, the share-link gallery): none of their routes
authenticates, so none of this reaches them, whatever the organiser has
accepted.

**Acceptance is recorded append-only**: one `TermsAcceptance` row per
user per version (`userId`, `version`, `acceptedAt`), never updated (a
database trigger refuses it, as for `ConsentRecord`) and never deleted by
product code (the foreign key cascades only so hard-deleted test fixtures
take their rows with them). Accepting the same version again adds no row
and keeps the first `acceptedAt`. **A refusal isn't stored**: the person
simply can't continue.

**Bumping `TERMS_VERSION` makes everyone accept again**: the check is for
a row of the current version, not for any row. Old rows stay, as the
record of what was accepted when.

The two endpoints (both authenticated, both exempt):

```
GET /api/terms/status
  200 { status: 'ok', data: {
        currentVersion: string,          // TERMS_VERSION
        acceptedVersion: string | null,  // the caller's latest acceptance, any version
        acceptedAt: string | null,       // ISO time of that acceptance
        mustAccept: boolean } }          // true until currentVersion itself is accepted

POST /api/terms/accept   body { version: string }
  200 the same shape as the status, after accepting (mustAccept: false)
  409 TERMS_VERSION_MISMATCH  version isn't the current one: the page showed older Terms
  400 (uncoded)               version missing or not a string
```

Only the current version can be accepted, so a page left open across a
version change can't record acceptance of words the person never saw.

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

A COMPLETED event can't be cancelled: 409 `EVENT_ALREADY_HAPPENED`, and
nobody is emailed. There's nothing left to call off, and guests must not
be told an event they attended was cancelled.

- `COMPLETED` is **never stored** — derived at read time from the last
  event day. The database row still reads `PUBLISHED`.
- Every path returning an event returns the **effective** status. A list
  showing `PUBLISHED` while the detail shows `COMPLETED` is a bug.
- `CANCELLED` is stored and has no reversal. Guests may already have been
  told. Cancelling emails every invited guest who hasn't declined (see
  "Announcements"); the status write is conditional, so two cancels racing
  email guests once.
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
status. **An archived event is private at once**: the gallery answers as an
inactive link, guest-view as unavailable, and guest uploads are refused
(see "Archived events: Memory Hub retention"). Organiser-side Memory
Hub management (`memory-hub.service.ts`'s non-guest methods) checks
neither `opensAt` nor cancellation — only tenant scoping and tier.

### Public vs private events

Genuinely different workflows, not a toggle:

**Private** — organiser builds the guest list, sends tokenised
invitations. Import, manual add, and send all apply.

**Public** — no organiser-built list. A shareable link is distributed;
guests add themselves by registering (below). Import, manual add, and
send are all rejected server-side.

In the UI, build **two variants**, not one screen with disabled fields.
Offering an action the backend will always reject reads as broken
software.

### Public events and self-registration

Behind `publicEvents`. A company shares one link ("register for the
year-end function here"); each person who registers becomes a guest with
their own invitation.

- **The link** carries `Event.shareToken` (`GET /api/events/:id/share-link`,
  `POST .../share-link/regenerate`; a published public event only). An
  unknown or regenerated token, or one for an event since made private, is
  a 404.
- **Settings** (`GET`/`PUT /api/events/:eventId/registration-settings`,
  organiser only, tenant-scoped and under the assignment lock): allowed
  email domains (stored lowercase without "@"; an email must be at exactly
  one of them, so `company.co.za` does not admit `mail.company.co.za`;
  empty = anyone), a cap, a closing date, the plus-ones each registrant may
  bring, and which days are open (`EventDay.openForRegistration`, on by
  default; at least one). The **cap** counts self-registered guests who
  haven't declined plus their plus-ones, and can't be set above the plan's
  guest limit (422); registration also stops at that limit itself. The
  **closing date** defaults to the RSVP deadline and can't be after it
  (422; the deadline's own day is fine); registration closes at whichever
  comes first, because a registrant can only change their answer until the
  deadline. Both are dates: a date-only one closes at the end of that day
  (see "Dates").
- **The view** (`GET /api/public-events/:shareToken`) is exactly what the
  registration page shows, as an explicit allowlist: name, host,
  description, cover, the live days with their venue and whether each is
  open, the event's questions (`rsvpFields`: `id`, `label`, `fieldType`,
  `isRequired`, `options`, live ones in order, exactly as the RSVP form
  receives them), and `registration` (`isOpen`, `reason`
  CANCELLED/CLOSED/FULL, `code`, its guest-facing `message`, `closesAt`,
  `plusOnesAllowed`, `allowedEmailDomains`). Day and question ids are the
  only ids in it (the form sends them back as `dayIds` and
  `rsvpResponses[].rsvpFieldId`). One rule decides open or not for the view,
  registration and the organiser's settings: `resolveRegistrationState`
  (`event-public/registration-rules.util.ts`). `reason` is the state the
  page lays out; `code` is the true cause, checked in this order:

  | `code` | `reason` | Means | `message` |
  |---|---|---|---|
  | `EVENT_CANCELLED` | CANCELLED | the event was cancelled | "This event has been cancelled." |
  | `EVENT_FINISHED` | CLOSED | its last day has ended | "This event has already taken place." |
  | `NOT_PUBLISHED` | CLOSED | a draft: registration has never opened | "Registration for this event is not open yet." |
  | `CLOSING_DATE_PASSED` | CLOSED | the organiser's closing date passed | "Registration for this event closed on 24 October 2026." |
  | `RSVP_DEADLINE_PASSED` | CLOSED | no earlier closing date; the RSVP deadline passed | "Replies for this event closed on 24 October 2026, so registration is closed." |
  | `NO_DAYS_OPEN` | CLOSED | every day is closed to registration | "Registration isn't open for any day of this event." |
  | `FULL` | FULL | the cap, the plan's guest limit or the hard ceiling | the full message |

  `null` while open. "Not open yet" is only ever a draft's. Registering
  refuses with the same `message` and the `REGISTRATION_*` code of its
  `reason` (see "Errors").
- **Opening the link:** 600 views / 5 minutes per IP
  (`publicEventViewLimiter`, `PUBLIC_EVENT_VIEWS_PER_IP_PER_5_MIN`; it was
  60). Nobody has a credential before registering, so it is keyed by IP. A
  company event's link goes out in one all-staff message and the whole
  office opens it within minutes from one IP; the page asks once per open,
  and 60 refused the 61st colleague. 600 covers ~300 people opening it
  twice. One response is the whole view, so a lower limit slows no one
  copying it; it only bounds load. Registering has its own limits (see
  "Guest-facing responses").
- **Registering** (`POST /api/public-events/:shareToken/register`: name,
  email, optional phone, `dayIds` from the open days, default all, and
  `plusOneNames` up to the allowance, and `rsvpResponses`, the answers to
  the event's questions in RSVP submit's own shape). Email is required and
  normalised before every check. Answers are checked and stored exactly as
  at RSVP (`rsvp-answers.util.ts`, same messages and codes; a registrant is
  attending, so required questions must be answered), on the registrant's
  own invite, so the guest details and the export show them like any
  RSVP's. Success creates the guest (`Guest.selfRegisteredAt`
  set) with an ACCEPTED invite offering every open day and attending the
  chosen ones, and each plus-one as an accepted Guest+Invite pair, exactly
  as RSVP creates them; then emails the personal link. **The invite token
  is never in the response**: only the email can open the invitation, or
  the domain restriction would mean nothing and a repeat registration
  would hand over someone else's invitation. Counting and writing happen
  under a row lock on the event, so two registrations can't both take the
  last seat or both create one email.
- **The answer never says whether an email or a phone is on the event.**
  Every check runs in the same order for every request, and a registration
  is answered the same way whoever is on the guest list: 201,
  `{ outcome: 'REGISTERED', emailSent, message: "Check your email for your
  e-velope." }`, byte for byte (a failed send: `emailSent: false` and one
  "couldn't send" message, also the same either way). A phone another
  guest has is saved like any other (phones aren't unique, see "Guest
  contact").
- **The same email again** creates no guest and gets exactly the answer a
  new registration with the same request would get: the success, or the
  same refusal (closed, full, no room for the party). Its own link is
  emailed to that address anyway, as "Here's your link again"
  (`buildRegistrationResendEmail`); that email is the only place that
  says they were already registered, and only its owner reads it. A form
  a new registration would be refused for (a closed day, too many
  plus-ones) is refused first and sends nothing. A cancelled or finished
  event refuses everyone and re-sends nothing, and an email outside the
  domains gets the domain refusal. If the organiser archived every invite
  the guest had, nothing is re-sent or re-created, and the answer is
  still the ordinary success. Accepted residuals: timing (a repeat writes
  nothing, so it answers a few database round trips sooner), and a
  registrant who lost their link while registration is closed or full
  sees that refusal, though the link reaches their inbox.
- **Afterwards a registrant is an ordinary guest.** `selfRegisteredAt` is a
  marker on the guest list, nothing more: they change their answer through
  `/rsvp` like anyone, and check-in lists them and their plus-ones like
  anyone. The differences: an RSVP edit that asks for more seats than
  the cap has left (adding plus-ones, or accepting after declining) is
  refused, and **the allowed domains hold at RSVP too**: changing to an
  email outside them is 422 `REGISTRATION_EMAIL_DOMAIN` with registration's
  own message (`emailDomainRefusal`, `registration-rules.util.ts`), for any
  guest on a public event with domains, or a registrant could register at
  the company address and swap it afterwards. The domains are on the
  public page, so the refusal reveals nothing. Only a change is checked:
  an address the guest already had before the domains were set never
  blocks their reply.

### Guest contact

Exactly **one** of email or phone **at creation** (organiser create and
import). Both fields exist on the model so the other can be captured at
RSVP time. Supplying both at creation is rejected. The exception is
public self-registration, where the email is required and a phone may sit
beside it. **The rule is for creation only:** `guestService.update`
checks only the fields it changes. A name or plus-ones change is never
refused for the contact the guest already has (both, from RSVP; or
phone-only while `sms` is off). A contact change is judged on what it
leaves behind: never no contact, with `sms` off an email, and never
an email another guest on the event has (409 `GUEST_EMAIL_TAKEN`,
compared in normal form, `guestRepository.isEmailUsedByOtherGuest`).

**The database guarantees it too:** a partial unique index,
`Guest_eventId_email_live_key`, on `("eventId", lower("email"))` for live
guests (`isArchived = false`, email set), created only in
`20261009091000_guest_email_unique` (Prisma can't express it). The
migration refuses to run while any duplicate exists;
`scripts/report-guest-email-duplicates.ts` lists them, read-only. Two
writes racing past the app's check trip the index, and each path answers
with its own refusal, never a 500 (`isGuestEmailUniqueViolation`,
`guest-validation.util.ts`): organiser create, update, import and restore
409 `GUEST_EMAIL_TAKEN`, RSVP 422 `CONTACT_EMAIL_UNAVAILABLE`, and
self-registration the ordinary "couldn't send" answer (identical either
way; registering again re-sends the link). Archiving a guest frees their
address; restoring them while a live guest has it is 409.

Names are nullable — a guest imported by phone supplies their name when
they RSVP.

Duplicate = same **email** on the **same event**. The same person across
two events is two unrelated records. **A phone is never anyone's
identity:** a household, a couple or a PA share one, so two guests on one
event may hold the same phone, on every path (organiser create, import,
RSVP, self-registration), and no response refuses or mentions another
guest's phone (`findDuplicateEmail`, `guest-validation.util.ts`). The one
check on a phone is inside a single import file: the same phone on two
phone-only rows is a duplicated row (a list pasted twice), refused and
listed like a repeated email ("appears more than once in this file (first
seen on row N)"). It is never compared with existing guests.

**An email another guest on the event has is refused at RSVP with one
neutral answer:** 422 `CONTACT_EMAIL_UNAVAILABLE`, "That email address
can't be used for this invitation. Please use another one.", the same
message, status and code for every cause, compared in normal form on both
sides (`guestRepository.isEmailUsedByOtherGuest`). **Accepted residual:**
refused vs accepted still tells whoever holds an invite whether an address
is on that event's guest list. Accepting the duplicate instead would make
one email two guests and break email as the identity registration and
re-sends rely on. The leak is bounded, not closed: 20 tries an hour per
invite (`rsvpSubmitInviteLimiter`), each successful try really changes
the guest's own email, and more invites cost an organiser's invitation or,
on a public event, a real inbox per registration.

**Emails are stored and compared lowercase and trimmed, everywhere** —
users, tenants, team invites, guests, sign-in lookups — through one
`normalizeEmail` (`shared/utils/email.util.ts`). Rows from before the rule
were brought in line by `20261006091000_lowercase_emails` (users, guests)
and `20261007090000_lowercase_tenant_emails` (tenants), which skip (never
merge) any row whose normalised email would collide: two users, two
tenants, or two guests on one event. `scripts/report-email-collisions.ts`
lists them, read-only. A comparison of a stored email still normalises
both sides, so a skipped row matches its other casing. The one place that
finds a tenant by email, Paystack's subscription webhooks
(`subscription.repository.ts`'s `findByEmail`), compares normalised forms
in SQL and matches **nothing** when two tenants share an address once
normalised: crediting the wrong tenant is worse than an unclaimed webhook.
A Postgres regex in a `$queryRaw` template literal needs its backslashes
doubled (`'^\\s+|\\s+$'`); a single `\s` reaches Postgres as a plain `s`.

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

### Host name

**Every event has a host name** (`Event.hostName`): the "From" line guests
see on the invitation and the sender name on guest emails. It is required
on event create (`POST /api/events`), every edit (`PUT /api/events/:id` and
the full update) and the wizard's materialize: missing, `null` or blank
after trimming is 422 `EVENT_HOST_NAME_REQUIRED`, and nothing is written
(`event-host-name.util.ts`'s `assertHostNamePresent`). Stored trimmed, at
most 200 characters.

**Older events saved without one aren't changed**: nothing backfills them,
and reading, publishing, inviting and the guest pages work as before (the
event name stands in, as it always has). **But their next edit must supply
one**: an edit is judged on the host name the event will have once saved,
the request's own when it sends `hostName`, else the stored one
(`assertHostNamePresentAfterEdit`). So an edit that leaves `hostName` out
is fine on an event that has one, and refused on one that hasn't, even a
full update touching only a day. The column stays nullable for those older
rows.

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
(`20261004090000_drop_event_venue_columns`). `/rsvp/validate`'s
`event.location`/`address` and coordinates remain as compatibility keys,
filled from the first day's venue. The public event view no longer has
them: no client ever read it, and it shows each day's venue.

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

### Event days and program items: dates

Two rules the wizard enforces, enforced on the server too, by one helper
each that every path calls (`event-day-validation.util.ts`'s
`assertDayDateNotPast`, `program-item-validation.util.ts`'s
`assertItemStartsOnItsDay`):

- **A day's date can't be in the past.** A new or changed date earlier than
  UTC today minus one day is 422 `EVENT_DAY_DATE_IN_PAST`. The one day of
  slack is for organisers behind UTC, whose today is still UTC yesterday:
  events have no time zone (see Known gaps), so the server can't know the
  organiser's own today. **Only a new or changed date is judged:** a saved
  day re-sent with its date unchanged is never refused, so an event that
  has already happened stays editable. Day create and update, the wizard's
  materialize and the full event update.
- **An item with a day starts on that day.** Its start time's UTC date must
  equal the day's date, or 422 `PROGRAM_ITEM_DATE_NOT_ON_DAY`. Judged on the
  item a change leaves behind (stored values filling in what isn't sent),
  and only when something about it changes: creating it, a new start or a
  new day, or (in the full update) its day's date moving without it. An
  older item already off its day can still be renamed. An item with no day
  (`NULL`) is placed by date as above and has nothing to match. Item create
  and update, materialize and the full update.

### Editing an event: the full update

**In edit mode, the wizard's steps change nothing on the server. Next only
moves between steps; every change is held until "Save changes", which
sends the whole event in one all-or-nothing request. Leaving without
saving discards everything. "Save changes" is blocked only by invalid
fields; with nothing changed, it sends nothing and says "No changes to
save".** (Events being edited may already be live: guests must never see a
half-applied edit, such as a new date before the organiser has saved.)

That request is `PUT /api/events/:eventId/full` (`src/modules/event-full-update/`),
organiser only (`requireEventAdmin`), scoped and under the assignment lock
through `eventService.getById` like every event lookup. The per-part
endpoints (`PUT /api/events/:id`, `/days`, `/tickets`, `/rsvp-fields`,
`/program`, `/program/:programId/items`, `/memory-hub/:id`) stay for the
other screens that use them.

The body, every key optional (a key left out leaves that part alone):

```
{
  event?:      { name?, description?, hostName?, coverImageUrl?, coverImagePublicId?,
                 coverImageBytes?, visibility?, ticketing?, rsvpDeadline?, capacity?,
                 ticketsRefundable? },                      // PUT /api/events/:id's body
  days?:       [{ id?, label?, date?, startTime?, endTime?, location?, address?,
                  latitude?, longitude? }],                 // PUT .../days/:id's body
  tickets?:    [{ id?, name?, description?, price?, currency?, totalQuantity?, isAvailable? }],
  rsvpFields?: [{ id?, label?, fieldType?, isRequired?, options? }],  // options: a JSON-encoded list of strings
  program?:    { title?, isPublished?,
                 items?: [{ id?, title?, description?, startTime?, durationMins?, dayIndex? }] },
  memoryHub?:  { opensAt?: string | null }
}
```

- **Each list is the whole list as the organiser left it.** A row with an
  `id` is a saved row, updated only where it changed; a row without one is
  new (and needs what its create endpoint needs); a saved row missing from
  the list is **archived**, as its DELETE does, never deleted. An `id` that
  isn't one of this event's live rows is that endpoint's 404 ("Event day
  not found", "Ticket not found", "RSVP field not found", "Program item not
  found"). The same id twice, or a list that isn't a list of objects, is an
  uncoded 400.
- **Order is position.** A question's and an item's `order` is its place in
  its list.
- **An item names its day by `dayIndex`**, its position in this request's
  `days` (a new day has no id yet), as materialize does; with `days` left
  out, its position in the event's live days by date (as GET returns them).
  `null` is no day. Left out on a saved item, its stored day is kept, as
  `PUT .../items/:id` keeps it. The multi-day rule is the item endpoints'.
- **Every check is its part's own**, through the same helpers (see "Event
  days and program items: dates", the venue, label, ticket, question and
  item helpers, and `event.service.ts`'s `assertEventFieldsValid` and
  `assertEventUpdateAllowed`), so every refusal has the same status, words
  and code as the per-part endpoint, and is judged on the event this save
  leaves: the RSVP deadline against the days it ends with, day labels
  unique across the resulting days, an item against its resulting day. A
  new question is the custom-questions tier gate, as on its POST. With
  `ticketing` off, a change to tickets is 422 with paid ticketing's own
  message (their routes are 404); re-sending them unchanged is fine.
- **Removing a day** follows DELETE `.../days/:id`: it is archived, with no
  refusal of its own. An archived day keeps its label, and the unique
  `(eventId, label)` index counts archived days, so a new day can't take a
  label a removed one held (409, the day endpoints' message), exactly as
  after a DELETE. Two saved days may swap labels in one save.
- **Cancelled and completed events follow today's rules**, which is none:
  no per-part edit endpoint refuses them, so this doesn't either.
- **All or nothing.** Every part is checked first, with nothing written;
  then only what changed is written, in one transaction holding the event's
  row lock (`eventRepository.withEventWriteLock`), so a refusal the
  database gives mid-save rolls back what was already written. A save that
  changes nothing writes nothing. A replaced cover is destroyed in
  Cloudinary only after the save commits.
- **The response** is `200 { status: 'ok', data }`, `data` exactly `GET
  /api/events/:id`'s (the event with its days, tickets, questions, program
  and items, Memory Hub and Event Pass, effective status, plus
  `acceptedGuestCount` and `guestLimit`), so the wizard can re-baseline
  from it.

### Reminders

Manual only — the organiser presses a button. Nothing here runs on a
timer by deliberate choice, with two exceptions, the feedback request sweep
(see "Feedback and sharing permissions") and the archived-media retention
sweep (see "Archived events: Memory Hub retention"), both built to be
correct whether or not their timer fires. They go through the same dispatch path as
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

The cooldown is claimed atomically before sending (`Invite.lastRemindedAt`,
for the whole batch in one conditional write, `claimReminders`) and
released for each guest whose send failed, so overlapping requests cannot
double-send and a failed send never starts it. Every attempt, failures included, is
written to `InviteReminderLog`.

### Announcements

Behind `announcements`. An organiser emails their guests ("Buses leave at
18:00"): `POST /api/events/:eventId/announcements/preview` (`audience`,
optional `eventDayId`: how many will receive it, and who can't be
reached), `POST /api/events/:eventId/announcements` (`subject` up to 150
characters, `body` up to 5000, plain text, both required) and `GET` for
the history: `{ announcements, dailyLimit }`, newest first. Organiser only,
tenant-scoped and under the assignment lock (`eventService.getScoped`).

- **Who is invited.** Live (never archived) guests with a live invite who
  are **not plus-ones** (covered by their host; their token is never given
  out), whose invitation reached them (`deliveredAt`) or who registered
  themselves. A guest still waiting on their invitation, or on a draft,
  hasn't heard of the event, so no announcement reaches them.
- **Audiences** (`announcement-audience.util.ts`, the one place):
  `EVERYONE` (hasn't declined), `ATTENDING`, `NOT_REPLIED`,
  `NOT_ATTENDING`. Narrowed to one live day, only guests invited to that
  day count, and ATTENDING means said they'll come that day; NOT_ATTENDING
  is declined, or accepted without that day; EVERYONE is ATTENDING or
  NOT_REPLIED for it.
- **Email only**, whatever `sms` says. A guest in the audience without an
  email is counted and listed as unreachable (with their phone), never
  silently skipped. An audience with nobody to email is 422.
- **The daily limit:** 5 announcements per event in any rolling 24 hours
  (`ANNOUNCEMENTS_PER_EVENT_PER_DAY`), then 429. Counted and claimed under
  a row lock on the event, so racing sends can't pass it. The sender
  address is shared by every tenant, so one organiser flooding inboxes
  costs everyone's deliverability. The history's `dailyLimit` (`perDay`,
  `windowHours`, `sentInWindow`, `remaining`, and `nextAvailableAt` once
  none are left) is the same count the send enforces: **the frontend keeps
  no copy of the number**, it shows these.
- **A cancelled event can't send** (409, preview too); its history still
  lists.
- **History** (`Announcement`, append-only): event, kind, subject, body,
  audience, day, sent by, sent at, recipients and unreachable counted when
  the send is claimed; one `AnnouncementDelivery` per guest emailed. Each
  entry's `sentCount` and `failureCount` are both counted from those rows,
  never `recipientCount` minus failures: after a crash mid-send some
  recipients have no row, and they weren't reached.
- **Cancellation.** `POST /api/events/:id/cancel` takes an optional `note`
  (up to 1000 characters, checked before anything is cancelled). Once
  cancelled, every invited guest who hasn't declined is emailed (no day,
  no limit) and it is recorded as kind `CANCELLATION`, unless nobody was in
  the audience. Emails failing never undoes the cancel: the response is
  the event plus `guestNotification` (sent, failed, each failure, the
  unreachable guests, the record). If the email couldn't be sent at all
  (a database failure before any went), `guestNotification.error` tells the
  organiser to **contact their guests directly**, never to send an
  announcement (a cancelled event refuses them), and `failures` and
  `unreachable` list every guest who wasn't reached; if even the audience
  couldn't be loaded, the message says so and points at the guest list.

### Safety limits

Hard limits in code, for mistakes and runaway clients rather than for
pricing. They are not tier settings and a `SUPER_ADMIN` can't raise them;
each refusal carries a code (see "Machine-readable codes" under Errors).

- **Venue capacity** (`Event.capacity`, `event-capacity.util.ts`): a whole
  number from 1 to 100,000, or none. Anything else is 422
  `EVENT_CAPACITY_INVALID`, never a value that reaches the integer column
  and comes back a 500 (a tester's 100,000,000,000 did).
- **5,000 guests per event, plus-ones included** (`MAX_GUESTS_PER_EVENT`,
  `guest-ceiling.util.ts`). Checked after the plan's own guest limit, so a
  limited plan's refusal is still the plan's, and a plan left unlimited
  stops here. Unlike the plan's limit it counts plus-ones: it bounds the
  rows an event holds, not what was sold. Every path that makes a live
  guest goes through it: organiser add, import and restore (422
  `EVENT_GUEST_CEILING`), self-registration (FULL / PARTY_TOO_LARGE, also on
  the public view) and plus-ones named at RSVP (409 `REGISTRATION_FULL`,
  "This event is full, so there isn't room for your plus-ones", checked under
  the event's row lock, only when an answer adds plus-ones). Organiser add,
  import and restore count and write under the event's row lock
  (`guestRepository.withEventGuestLock`, the lock registration takes), so
  two at once can't both pass it, nor the plan's own limit.
- **Guest import:** at most 2,000 rows per file (`MAX_IMPORT_ROWS`), refused
  whole before any row is validated (422 `GUEST_IMPORT_TOO_MANY_ROWS`), and
  at most 5 MB (413 `GUEST_IMPORT_FILE_TOO_LARGE`). The import's write
  transaction allows 30 seconds: a full 2,000-row file took about 11 against
  the remote test database, past Prisma's 5-second default.
  A workbook's comments and notes are dropped before exceljs loads it
  (`guest-import.engine.ts`, `withoutComments`): exceljs 4.4.0 finds them
  only at the path Excel itself writes, and any other valid layout (an
  absolute Target, a comments part in a subfolder, a VML drawing by another
  name, as other spreadsheet apps write) threw "Cannot read properties of
  undefined (reading 'comments')", a 500. The import reads only the first
  sheet's first five columns, so nothing it uses is lost. The workbook is
  unpacked part by part with the bytes counted as they inflate (never the
  sizes the file declares, which a crafted file can fake) and refused as
  unreadable past 3 MB in any one part (`MAX_UNPACKED_PART_BYTES`) or
  4 MB in all (`MAX_UNPACKED_WORKBOOK_BYTES`): a few KB uploaded can
  unpack to gigabytes, and exceljs holds the whole workbook in memory. A
  real 2,000-row list unpacks to about 0.6 MB, so the caps are 5 and 6.5
  times a full import, and `MAX_IMPORT_ROWS` already caps the rows.
  Measured 2026-10-25, reading alone in a fresh process: that list about
  21 MB and 0.1 s; 2,000 rows with extra columns unpacking to 3.9 MB, just
  under the total, about 75 MB and 0.35 s. The rest of the import doesn't
  grow with columns it never reads. The template
  therefore has no cell comments: its notes are on an "Instructions" sheet
  after "Guests" (a notes row under the header would be imported as a
  guest). Measured 2026-10-25 (`tests/perf/import-timing.test.ts`, each
  case in a fresh process, remote test database): 300 rows about 6 s and
  under 60 MB above the starting memory, .xlsx or .csv; 2,000 rows about
  10 s (.xlsx, +113 MB) and 11 s (.csv, +139 MB). Reading the file is the
  small part (2,000 rows of .xlsx: about 0.2 s and 21 MB; .csv: nothing
  measurable); the rest is validating and writing. Against staging's
  512 MB that is room for one import at a time; the server's own idle
  memory on Render and several 2,000-row imports at once have not been
  measured.
- **Invitation and reminder emails: 2,000 per event in any rolling 24 hours**
  (`EVENT_EMAILS_PER_DAY`, `event-email-limit.util.ts`). A 300-guest event's
  invitations and a reminder round are 600; a 1,000-guest event still fits
  both in a day; a runaway loop stops at 2,000 instead of draining the shared
  Resend quota. Every invitation email (bulk or a single resend) and
  reminder email counts, claimed before anything goes under a row lock on
  the event (`EventEmailClaim`, append-only, one row per send with its
  count), so a refused email still counts and racing sends can't pass it.
  All-or-nothing: 429 `EVENT_EMAIL_DAILY_LIMIT`, nothing sent, no reminder
  cooldown started, saying how many could still go. SMS, announcements
  (their own limit), the cancellation email and registration emails are not
  counted.

### Memory Hub download

Behind `memoryHubDownload`. `POST /api/events/:eventId/memory-hub/download`
(organiser only, tenant-scoped, under the assignment lock, the plan's Memory
Hub gate; `memory-hub-download.service.ts`) returns links to zip files of the
event's **approved, live** items in original quality: `{ itemCount,
photoCount, videoCount, expiresAt, parts: [{ part, partCount, mediaType,
itemCount, bytes, fileName, url }] }`.

- **Never through this server.** Each `url` is a signed Cloudinary
  `generate_archive` URL in `download` mode
  (`shared/cloudinary/cloudinary-archive.util.ts`): the browser fetches it,
  Cloudinary zips the originals and streams them back, nothing is stored.
- **By exact public id**, never by folder prefix (the folder holds pending
  and rejected uploads too). Only ids in this event's own folder
  (`isSignedPublicIdInFolder`). Videos only while `memoryHubVideo` is on.
- **Parts.** One archive holds one resource type, so photos and videos are
  separate parts, photos first, oldest first. A part closes at 1,000 files
  (Cloudinary's limit), 95 MB of originals (its limit is at least 100 MB) or
  a 12,000-character URL, whichever comes first. The URL is what binds:
  every id is in it, and Cloudinary refuses a request line past about 16 KB
  with a 414 (measured: a 16,336-character URL worked, 16,628 did not), so a
  part holds about 80 photos.
- **Names.** Each zip is `<event name>-photos[-part-N-of-M].zip`, the name
  reduced to letters, digits and hyphens with anything like an email
  address or a phone number removed. Inside, each file is named by its
  public id's random UUID: Cloudinary's archive API can't name files one
  by one (only the public id, or the original upload filename, which is
  whatever the guest's phone called it and is never used).
- **Links last 30 minutes.** Every fetch rebuilds the zip at Cloudinary's
  cost, so a link should die before it can be forwarded and reused, yet
  live long enough to start every part on a slow connection (Cloudinary
  checks the expiry when a download starts).
- **Rate limited per event:** 5 sets of links an hour
  (`memoryHubDownloadLimiter`), counting only successes, then 429
  `MEMORY_HUB_DOWNLOAD_RATE_LIMIT`. Nothing approved is 422
  `MEMORY_HUB_NOTHING_TO_DOWNLOAD`.

### Feedback and sharing permissions

Behind `feedback`. After an event we ask its organisers how it went and
whether e-velope may feature their company, quote them, contact them about
a case study and share photos they choose. Guests decide for their own
photos.

**Consent records.** Every permission given or withdrawn is one
`ConsentRecord` (`src/modules/consent/`), append-only (see "Soft delete"):
who (exactly one of an organiser's `userId` or the uploading guest's
`guestId`), the event, the kind (`COMPANY_NAME_LOGO`, `QUOTE`,
`CASE_STUDY_CONTACT` for the whole event; `PHOTO_ORGANISER_SELECTED` and
`PHOTO_GUEST_PUBLIC_SHARING` per photo, with its `memoryItemId`),
`GRANTED` or `WITHDRAWN`, the exact wording shown and its version, and
when. **The current state of a subject (event + kind, + photo) is its
latest record by `seq`**, `NOT_GIVEN` when it has none
(`foldConsentStates`, `consent.service.ts`); never read a single record as
the state. Only a change is recorded: re-sending what is current appends
nothing. CHECK constraints keep a guest to `PHOTO_GUEST_PUBLIC_SHARING`
only, and an organiser off it.

**All consent wording lives in `consent-wording.ts`** (`src/modules/consent/`),
one list of versions per kind; the current wording is the last. The server
stores the current text and version on each record, and sends the same
text to the frontend (the feedback GET's `wording`, guest-view's
`publicSharing.wording`), which shows it and keeps no copy. **Changing the
words means a new version appended to the list**, never an edit: old
records keep the wording they were given.

**The guest's opt-in.** `POST /api/memory-hub/guest-items` takes an optional
`allowPublicSharing`, **off unless it is exactly `true`**; true records a
`PHOTO_GUEST_PUBLIC_SHARING` grant for the new photo in the same
transaction ("Happy for this photo to be shared publicly by the organiser
and e-velope."). Photos only (a video: 422 `PUBLIC_SHARING_PHOTOS_ONLY`).
The guest changes it later through their invite token, `POST
/api/memory-hub/guest-items/:itemId/public-sharing` (`{ token,
allowPublicSharing }`, their own live photos only, anything else 404,
allowed whatever the event's state so they can always withdraw; the upload
limiters). Guest-view's `publicSharing.myItems` lists each of their pending
and approved photos with its current setting. Organiser uploads carry no
opt-in, so they are never eligible.

**Organiser feedback** (`/api/events/:eventId/feedback`, organiser only,
tenant-scoped and under the assignment lock through `getScoped`): one per
event (`EventFeedback`), saved only once the event is `COMPLETED`, editable
afterwards. `GET` returns the feedback (or null), `available`, each
event-level permission's state, the eligible photos and the current
selection, the wording of every tick and the logo limits. `PUT` takes
`score` (0–10, required on the first save), `workedBest` and `toImprove`
(up to 2000 characters, blank stored as null), `permissions` (the three
event-level kinds, true/false), `selectedPhotoIds` (the whole selection:
added photos are granted, missing ones withdrawn) and `logo` (`{ url,
publicId, bytes }` from `POST .../feedback/logo-signature`, signed into the
tenant's own `feedback-logos` folder and checked like every Cloudinary
asset; null removes it). One transaction under a row lock on the event.
**A photo newly selected must be eligible now**, or nothing is saved (422).
A `SUPER_ADMIN` can read it but not save it (403): a permission is the
company's to give. `GET /api/events` carries `feedbackGiven` on every
event (live feedback exists), read for the whole list in one query, so the
list's cards never ask one by one; it is left out while `feedback` is off.

**Eligible and shareable — one rule** (`feedback-photos.util.ts`).
Eligible (the organiser may select it): approved, not archived, a photo, a
guest's upload to the event's live album, in the event's own folder, AND
its guest's opt-in currently granted. **Shareable** (the super admin may
use it): eligible AND the organiser's selection currently granted. **Every
condition, every time it is read**: a photo rejected or archived since, or
whose guest or organiser has since withdrawn, drops out with no other step.
A selection whose guest later withdraws stands as the organiser's record
but is not shareable.

**Super admin** (`/api/admin/feedback`, `SUPER_ADMIN` only, the global 404
for everyone else): the list (event, company, dates, score, answers, logo,
each permission's status with when it was given, the wording version and,
when withdrawn, when; selected and shareable photo counts), `GET
/:eventId/shareable-photos` (each shareable photo with both consents, and
Memory Hub download-style zip links of the originals, 30 minutes) and `GET
/export` (the list as CSV; every cell an organiser typed is defused for
spreadsheets, a leading `=`, `+`, `-`, `@`, tab or CR prefixed with `'`).

**The request email** (`feedback-request.service.ts`) is **a scheduled
job** (one of two, with the archived-media retention sweep): a periodic
in-process sweep, started by `server.ts` (never
`app.ts`, so tests start no timer), every 15 minutes. From 08:00 UTC the
day after an event's last day, once it is `COMPLETED`, its organisers (the
creator and the members assigned to it, active and able to open it; none
left, the tenant's active `TENANT_ADMIN`s: `resolveEventOrganisers`,
`event-organisers.util.ts`) are emailed once. **Once is the
claim, not the timer:** a `FeedbackRequestClaim` row, unique per event, is
inserted before anything is sent, so two sweeps racing (on one server or
several) or a restart email once; a send that fails after the claim is not
retried. It catches up: a server asleep at the due time sends on its next
sweep, for events whose last day was within the last 7 days, and never for
older ones. Never for a cancelled, draft or archived event, an archived
tenant, an event with feedback already given, or with `feedback` off.

### Archived events: Memory Hub retention

**30 days after an event is archived, its Memory Hub photos and videos are
deleted from Cloudinary** (`MEDIA_RETENTION_DAYS`,
`event/event-media-retention.util.ts`; the sweep is
`media-retention/media-retention.service.ts`). Everything else is kept: the
event, its cover photo, its invitation design, and every `MemoryItem` row,
marked `purgedAt` and archived, so every live-items query (the gallery,
guest-view, the download, the storage quota, the feedback photos) leaves it
out with no check of its own. Until 2026-10 archiving changed nothing in
Cloudinary and the media was kept forever.

- **The clock.** Archiving sets `Event.archivedAt`; restoring clears it.
  Only a live event can be archived, so the clock never moves while
  archived. Events archived before the column existed were given the
  migration's own time (`20261026090000_archive_media_retention`), never an
  older guess, so nothing was purged at deploy.
- **The purge** is one `EventMediaPurge` per event and archiving (unique
  `(eventId, archivedAt)`), inserted under the event's row lock while it is
  still archived and due, so it is claimed once however many sweeps race on
  however many servers, and a restore lands either before it (cancelled) or
  after (the event comes back without its media). Working on it takes a
  lease (a conditional write, 10 minutes), so one sweep at a time. Every
  item of the hub that existed when the purge began is deleted, whatever
  its status, by exact public id in Cloudinary Admin API batches of 100
  (`destroyAssets`, `cloudinary.client.ts`, with the CDN cache
  invalidated), each id checked against the event's own Memory Hub folder
  first (`isSignedPublicIdInFolder`): one outside it is hidden, never sent.
  Each item is marked as its batch succeeds; one Cloudinary refuses stays
  unpurged, the purge records `failedCount` and `lastError`, Sentry hears of
  it, and the next sweep tries again. "Not found" counts as deleted, so a
  rerun is always safe. A purge that has begun always finishes, a restore
  included, and never touches an item uploaded after it began.
- **The reminder.** 7 days before (`MEDIA_PURGE_REMINDER_DAYS_BEFORE`), the
  event's organisers (`resolveEventOrganisers`, as the feedback request)
  get one email (see "Email"), claimed once per event and archiving
  (`MediaPurgeReminderClaim`) before it is sent. Not for a restored event,
  one whose purge has already begun, or one with nothing to download (no
  live approved item). **A purge never runs until its reminder went at least
  7 days earlier** (`mediaPurgeDueAt(archivedAt, remindedAt)`, the later of
  archivedAt + 30 days and remindedAt + 7 days): a late reminder (the sweep
  down, or `archiveMediaPurge` off past the 30 days) goes on the next sweep,
  however late, with the date a week on, and the purge waits for that date.
  The claim records the sweep's own time as `claimedAt`, the time the
  email's date was worked out from. Only an event with nothing to download
  needs no reminder, and is purged at 30 days.
- **The sweep** runs every 15 minutes, in-process, started by `server.ts`
  only (two minutes after startup, after the feedback request's first): the
  reminders due, then the purges due, then every unfinished purge no other
  sweep holds. One event failing never stops the others.
- **Organisers can read an archived event, never write to it.** `GET
  /api/events?archived=true` lists the caller's archived events (scope and
  assignment lock as ever); `GET /api/events/:id`, the Memory Hub's detail,
  its items and its download open an archived event, so its organisers can
  keep the photos. Every other route, and every write, is still the 404.
  Restoring stays a super admin action (`POST /api/events/:id/reactivate`),
  held to the plan's active-event limit (403 `EVENT_LIMIT_REACHED`; an event
  that has held an Event Pass doesn't count, as at creation).
- **The countdown.** Every event in the lists (`GET /api/events`, with or
  without `archived`, and the super admin's `/api/tenants/:id/events`) and
  every event view (`GET /api/events/:id` and every response built on it)
  carries `archivedAt` (null while live), `mediaPurgeAt` (while archived:
  when the media is or was deleted: the purge's own start once begun; else
  `archivedAt` + 30 days, or a week after a late reminder; with a reminder
  overdue but not yet sent, a week from now, the earliest it can be; null
  while live, and while `archiveMediaPurge` is off unless a purge had
  begun) and `mediaPurgedAt` (when its
  media was last deleted completely, kept after a restore; null if never)
  (`withMediaRetention`). The frontend shows these and keeps no copy of the
  30 days.
- **A super admin can purge now:** `POST
  /api/admin/events/:eventId/media-purge`, `SUPER_ADMIN` only, the global
  404 for everyone else (`requireSuperAdminHidden`). The same claim and run
  as the sweep, recorded with who asked (`requestedBy`) and when
  (`startedAt`, `reason: SUPER_ADMIN`); it answers with the purge
  (`eventId`, `reason`, `requestedBy`, `startedAt`, `completedAt`,
  `purgedCount`, `failedCount`). A live event is 409 `EVENT_NOT_ARCHIVED`;
  a purge already begun for this archiving is 409
  `MEDIA_PURGE_ALREADY_STARTED`.
- **Private to guests at once.** From the moment it is archived (not 30
  days later), an event's album is closed to everyone but its organisers:
  the share link answers exactly as an unknown one (404, "This link isn't
  active."), guest-view is `{ available: false }` like every other blocked
  state, and a guest upload signature or save is 404 "This photo album isn't
  available." An upload signed before the archive and saved after has its
  file removed (only if it is in this event's folder). None of these says
  why. The guest's public-sharing toggle still works, so a guest can always
  withdraw. Restoring the event opens the album again (without its media,
  once purged).
- **The guest's invitation closes too.** `GET /api/rsvp/validate/:token`
  for an archived event is 410 "This event is no longer available." (one
  neutral line, nothing about the event), and `POST /api/rsvp/submit` and
  the ticket quote are the same 410 before anything is read or written;
  the Program tab (`POST /api/rsvp/program`) is `{ available: false }`.
  Until 2026-10 an archived event's invitation showed in full and still
  took RSVP changes. Restoring opens it again.
- **Behind `archiveMediaPurge`** (on unless switched off; see "Feature
  flags"): off, nothing is reminded or deleted. Archiving still records
  `archivedAt`, so the clock keeps running, but the purge still waits for
  its reminder: **switched back on, an event archived more than 30 days
  earlier is reminded on the next sweep and purged a week after it**,
  never at once.

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

### Sign-up: the organisation address

The organisation's address (`Tenant.slug`, unique across every tenant,
archived ones included) is **optional at sign-up** (`POST
/api/auth/register`: `{ username, tenantName, tenantSlug? }`). The form
fills it from the organisation's name but no longer presents it as a
required field (`src/modules/auth/tenant-slug.util.ts`):

- **Blank, missing or `null`**: made from `tenantName`: accents dropped,
  lowercased, every run of other characters one hyphen, none at either end,
  at most 60 characters. A name with no letters or digits gives
  `organisation`.
- **Typed**: trimmed and lowercased, then it must already be valid
  (lowercase letters, digits and single hyphens, at most 60 characters), or
  it is 422 `TENANT_SLUG_INVALID`. A typed address is never rewritten into
  something the person didn't type.
- **Taken** (typed or made): never refused. The next free one is used
  instead, `name-2`, `name-3`, ..., shortening the base so the suffix fits
  in 60. Two sign-ups racing for the same address: the loser looks again
  (up to three times) instead of getting an error.

`tenantName` is required and must not be blank (400). The response's
`tenant.slug` is the address actually given.

### Team roles and invitations

Behind the `teamMembers` flag. A tenant has two kinds of member:

- **`TENANT_ADMIN`** manages the team, billing and every event. Never
  locked by assignments: a promotion to it clears the user's assignments
  in the same transaction (a later demotion starts unlocked, never with
  stale ones), and assignments for one are 422.
- **`EVENT_ADMIN`** (a team member) works on events, subject to the
  assignment lock (see Tenant scoping).

**A tenant always keeps one active `TENANT_ADMIN`.** Demoting or
suspending the last one is 409, whoever asks (a `SUPER_ADMIN` too),
checked inside a transaction that holds a row lock on the tenant
(`user.repository.ts`'s `withTenantTeamLock`), so two admins demoting or
suspending each other at once can't both succeed. **Nobody can suspend
themselves** (403), or change their own role (403, as before).

Team management is the existing `/api/users` router, extended:
`GET /api/users` for a `TENANT_ADMIN` lists every member of the tenant,
suspended ones included (where else would they be reactivated?), each
with `status` (`ACTIVE`/`SUSPENDED`) and `assignments`;
`PUT /api/users/:id` writes only `username` and `role` (it used to spread
the body into Prisma); a `TENANT_ADMIN` may now suspend and reactivate
their own members (`POST /:id/suspend`, `/:id/reactivate`); assignments
are `PUT /api/users/:id/assignments` (the whole list). Suspending revokes
every device token, as before. With `vendors` off, creating an
`EVENT_VENDOR` or **changing** someone to one is 422.

**Invitations** (`TeamInvite`, `/api/users/invites`, `TENANT_ADMIN` only):
an email, a role (`TENANT_ADMIN` or `EVENT_ADMIN`) and, for an
`EVENT_ADMIN`, optional event assignments. The token is 256 random bits
in the emailed link only; the row keeps its SHA-256 hash, like a device
token, and it is never logged. Valid 7 days, single use, at most one open
invite per tenant and email (a partial unique index). Resending mints a
new token and expiry (the old link stops working); revoking sets
`revokedAt`. Acceptance: the frontend's `/join` page reads the invite
(`POST /api/team-invites/lookup`: email, company name, role, expiry),
creates the Firebase account for that email, locked, and calls `POST
/api/team-invites/accept` with the new account's Firebase ID token, the
invite token and a name. The backend checks the Firebase email matches,
then in one transaction claims the invite, creates the `User` in the
inviting tenant with the invited role, and creates the assignments that
still name live events. The device code step follows on first sign-in.
Users belong to one tenant: an address that already has an account can't
be invited or accept (409 `USER_EMAIL_TAKEN`). An `EVENT_ADMIN` invite all
of whose events have been archived since is refused (422) rather than
accepted unlocked. Create and resend are limited per admin; lookup and
accept per token hash and per IP (failures only).

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

**"RSVP by 25 October" means until the end of 25 October.** The RSVP
deadline and the registration closing date are dates
(`event/event-rsvp-deadline.util.ts`). A date-only value (`2026-10-25`) is
stored as the end of that day (`parseDeadline`), and every comparison reads
a stored one through `deadlineEnd`/`hasDeadlinePassed`: one stored at UTC
midnight (written date-only before 2026-10) or at 23:59:59 (the wizard's
`toRsvpDeadlinePayload`) closes at 23:59:59.999 of its day; any other time
is a deliberate instant, kept as given. RSVP submit, the guest page's
`isRsvpDeadlinePassed`, reminders, registration closing, the settings'
"not after the deadline" and "not in the past" at creation all use it. The
deadline can be any day up to and including the event's last day, whatever
time that day ends: a lunch ending at 14:00 can take replies "by" its own
date. Never compare a deadline with `<` on the stored value.

### Terminology

| Term | Applies to | Means |
|---|---|---|
| **Suspend** | Tenants and users only | Locked out of the platform |
| **Archive** | Everything else | Soft-deleted, reversible |
| **Cancel** | Events only | Called off, irreversible |

Never use "Delete" in user-facing copy. Nothing is deleted, with one
exception that says so plainly: an archived event's Memory Hub photos and
videos really are deleted after 30 days, so their reminder, the countdown
and their refusals say "deleted" (see "Archived events: Memory Hub
retention"). "Archive" there would promise a restore that can't happen.

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

**No dashes as punctuation in user-visible text; hints are one short
line.** This covers both repos: messages, emails, SMS, spreadsheets, labels
and alt text. Use a full stop, comma or colon instead of an em dash (—), an
en dash (–) or a spaced hyphen between clauses, and "to" in a range ("14:00
to 22:00"). Hyphens inside words stay ("e-velope", "plus-ones"). A message
is at most two short sentences, and keeps what the person needs to fix the
problem.

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
  A wizard's Next checks its own step only. In the event wizard's edit
  mode, Next saves nothing: see "Editing an event: the full update" under
  Domain rules.
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
- **Product wording is neutral about who the event is for:** never
  mention year-end functions, companies or any target audience in the
  product; targeting belongs in marketing. Custom RSVP questions are
  called 'Additional fields' in all user-visible text.

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
| `mashware-logo.svg` | Full logo with tagline, olive lettering: `/mashware` in light mode | "MashWare: Brave As Code, Emerging While Others Crash" |
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
hard-deleted by the tests themselves (`tests/helpers/`). **The tier rows
(`SubscriptionTierConfig`) are shared by every suite:** a test that changes
one saves every row first and restores it with an upsert of the whole saved
row, `updatedAt` included, or removes a row only if it created it; it never
deletes a row it found. To test "no config row", stub
`subscriptionTierConfigRepository.findByTier` (`vi.spyOn`) instead
(`tests/subscription/tier-capability-settings.test.ts`). The test database
is still a real remote Postgres, which is what catches round-trip bugs
like the Prisma transaction timeout at 50 rows that a fast local database
or a 5-row fixture would never show.

**Every fixture user has accepted the current Terms of Service** unless the
test says otherwise: the user helpers (`createTestTenantAndUser`,
`createTestUserRow`, `createActor`) add the acceptance row in the same
create (`termsAcceptedUnless`, `tests/helpers/db.ts`); pass `acceptTerms:
false` for a user who hasn't. A user created another way (through
register or a team invitation, or a bare `prisma.user.create`) has none,
and gets 403 `TERMS_NOT_ACCEPTED` on any authenticated route until the test
accepts for them.

**Every feature flag is on in tests,** whatever `.env`'s
`FEATURES_DISABLED` says: `tests/setup.ts` sets it empty before anything
loads `.env`, so a developer's launch-mode `.env` can't make a test pass or
fail. A test about a switched-off feature sets the flag itself
(`vi.stubEnv('FEATURES_DISABLED', …)`, undone by `vi.unstubAllEnvs()`).

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

- **Reminders and organiser resends are refused on public events**
  (`assertEventAcceptsInvites`). Registrants are accepted, so a reminder
  would skip them anyway; a registrant who lost their link registers again
  with the same email to have it re-sent.
- **Announcements are email only and sent in the request.** A guest
  without an email can't be reached (they are listed to the organiser).
  Every guest send still finishes before the response returns: batched,
  300 guests are three Resend calls rather than 300, but there is no queue
  behind it, and SMS is still one call per guest. A crash mid-send leaves
  fewer delivery rows than the announcement's recipient count.
- **Refunds are not built.** Cancelling a paid event will need a refund
  pipeline once payments exist.
- **The frontend doesn't follow the 2026-10 deadline and registration
  changes yet** (backend `hotfix/rsvp-deadline`). The wizard's own check
  (`event-wizard.form.ts`'s `rsvpDeadlineProblem`) still refuses a deadline
  on a last day that has an end time; the registration settings panel loads
  its settings once, so after publishing from the control center it shows
  "Closed" with the draft's "not open yet" message until reloaded; it and
  the register page key on `reason` only, not `code`; the register page
  doesn't show or send the event's questions (`rsvpFields`,
  `rsvpResponses`); and `isRsvpDeadlinePassed` and the reminder check in
  `event-display.util.ts`/`reminder.util.ts` compare the stored instant.
- **Archived-event retention needs its frontend half** (backend
  `feature/archive-retention`): an Archived list (`GET
  /api/events?archived=true`) with the countdown to `mediaPurgeAt`, an
  archived event opening read-only (its Memories tab and download working,
  every write hidden), and the super admin's purge button. Until then the
  reminder's button opens the event's Memories tab, which the current
  frontend may not show for an archived event. Remove this entry once
  built.
- **The pilot polish needs its frontend half** (backend
  `feature/pilot-polish`): a Terms screen answering `TERMS_NOT_ACCEPTED`,
  event forms requiring a host name, and the sign-up form no longer
  requiring the organisation address. **Deploy the frontend's Terms screen
  with or before this backend**: without it, every signed-in user, super
  admins included, gets 403 on every page. Remove this entry once both
  are live.
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
    `authenticate` middleware, `register`, `request-otp` and `verify-otp`
    answering a rejected Firebase token with a 401 (and an outage still
    with a 500), the test-database isolation guard,
    username escaping in auth emails, and the organisation address at
    sign-up (`register-slug.test.ts`: made from the name when blank, the
    next free one when taken, a typed invalid one 422 `TENANT_SLUG_INVALID`).
  - **Terms of Service** (`tests/terms/`): a new user blocked until they
    accept, super admins too; the wrong or a missing version refused with
    nothing stored; accepting twice keeps one row; a user holding only an
    earlier version blocked again; the exempt routes (status, accept,
    `/api/tenants/me`, `/api/config/features`, exchange, refresh, sign-out)
    working before accepting; a new sign-up and a team member joining by
    invitation blocked until they accept; a guest's RSVP page unaffected.
  - **Tenant scoping** (`tests/tenant-scope/`): fail-closed lookups for
    a caller with no tenant, event program and program items across
    tenants, vendor-space membership, `TENANT_ADMIN`/`EVENT_ADMIN`
    refused without a tenant at creation, tickets and custom RSVP fields
    across tenants and under the wrong event (plus the SPARK custom-field
    gate and organiser-only ticket reads), event days under the wrong
    event, and Event Pass and SMS-bundle reconcile scoped to the URL's
    event and the caller's tenant.
  - **Program defaults** (`tests/event-program/`): visible by default on
    both creation paths and still hideable, the publish migration, and a
    program item's `order` defaulting to the end of the list.
  - **Guest-facing responses**: RSVP `submit()`'s exact response shape,
    the guest program contract, archived event days hidden from guests
    and refused at submit (`tests/rsvp/`); Memory Hub guest view,
    guest-safe wording and the per-invite upload rate limit
    (`tests/memory-hub/`); invite email escaping (`tests/invite/`, which
    sets its own `FRONTEND_BASE_URL` so it runs alone).
  - **Batched sending** (`tests/invite/batch-sending.test.ts`): 100 per
    Resend call in order, one refused email failing alone, a refused or
    thrown batch call failing only its own recipients while the next batch
    goes; over HTTP on a 205-guest event, invitations (each guest's own
    link, delivered marked), reminders (cooldown and log per guest) and an
    announcement (delivery rows) across three batches, with one batch
    failing. How long a 300-guest send takes is measured, opt-in, by
    `MEASURE_SEND_TIMING=1 npx vitest run tests/perf/send-timing.test.ts`.
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
    blank refused, publish refusing a venue-less day, and the event
    carrying no venue columns. (The venue migration's data-copy test was
    retired with the columns it read.) Guest side (`tests/rsvp/rsvp-day-venue.test.ts`):
    per-day venues on `/rsvp/validate`, `/rsvp/program` and the sent emails.
  - **RSVP contact update** (`tests/rsvp/rsvp-contact-update.test.ts`)
    and its error codes (`tests/rsvp/rsvp-contact-codes.test.ts`); the
    per-invite submit limit, 20 an hour (`tests/rsvp/rsvp-submit-rate-limit.test.ts`).
  - **Guest contact rules** (`tests/guest/`): two guests on one event
    sharing a phone on organiser create, import and RSVP, with nothing
    mentioning the other guest; an email another guest has refused at RSVP
    with the neutral `CONTACT_EMAIL_UNAVAILABLE`, in any casing, and by
    an organiser edit with `GUEST_EMAIL_TAKEN`; a phone repeated within
    one import file flagged, one an existing guest has imported; update
    checking only what it changes (a guest with both contacts, and a
    phone-only guest with sms off, renamed and given plus-ones); the
    plus-ones allowance 0–20 on create, update and import. Allowed
    domains at RSVP (`tests/public-events/rsvp-email-domain.test.ts`):
    registration's refusal for a change outside them, an address held
    from before never blocking a reply. Forgot password's email limiter
    keyed per IP without an email (`tests/auth/forgot-password-email-limit.test.ts`).
  - **Required fields** (`tests/validation/`): 422 on blanks for program
    items, tickets, custom RSVP fields, guests, the wizard's materialize,
    and RSVP submit (attending, name, required custom questions). The
    frontend's form rules on the server (`frontend-rule-parity.test.ts`):
    whole-number durations, ticket quantities and tier limits, day end
    after start, an item's day on a multi-day event, SMS credits 1–5000,
    host name length, typed custom answers, and the international phone
    message and code. The host name required on create, edit, the full
    update and materialize (`host-name-required.test.ts`), including an
    older event with none.
  - **Wizard draft conversion** (`tests/event-draft/`): `hostName`
    carried through (refused when absent or blank), a legacy
    `invitationTemplate` in an old draft ignored, and each program item's
    day (`dayIndex`) and the program's visibility set in one step.
  - **Client-supplied Cloudinary assets** (`tests/cloudinary/`): foreign
    publicIds and mismatched URLs refused with nothing destroyed, on
    Memory Hub uploads and event covers.
  - **The global error handler** (`tests/errors/`): no raw Prisma text
    in a response; a duplicate user email is 409 `USER_EMAIL_TAKEN`, not
    a 500.
  - **Tenant emails** (`tests/subscription/`): Paystack's subscription
    lookup finds a tenant whatever case and padding either side has,
    matches neither of two colliding tenants, and the tenant email
    migration skips collisions.
  - **Team members** (`tests/team/`): the assignment lock (an unlocked
    member sees every event; a locked one gets 404 on an unassigned event,
    its guests, invites, check-in, `/api/guests/:id` and RSVP responses,
    and a list of only their events; import still works through multer;
    create auto-assigns; the last assignment is 409 without
    `confirmWidening`; outside a request it fails closed), team roles (the
    last `TENANT_ADMIN` can't be demoted or suspended, including two
    demotions racing; no self-suspend; vendor role change 422 with
    vendors off; `PUT` ignores other fields; promotion clears
    assignments), invitations (lowercased email, only the hash stored, the
    raw token never logged, can't be accepted twice, after expiry, by
    another email or by an existing account; resend rotates; revoke), and
    email normalisation (case-insensitive `USER_EMAIL_TAKEN`, the
    database race as 409, and the lowercase migration's collision skips).
  - **Public events** (`tests/public-events/`): registration creates an
    accepted guest with their days and plus-ones and emails the link
    (never returned); allowed domains; the cap with plus-ones (and at
    RSVP), the plan's limit in guest words; the closing date and the RSVP
    deadline default; a cancelled event; the same email again answered
    byte for byte as a new registration (success, full, closed, a refused
    form, all invites archived), re-sent as "Here's your link again" and
    never duplicated; a phone another guest has saved, with an identical
    answer and the other guest untouched; the view's exact keys and no
    internal values; every form and settings error code; settings
    validation, scoping and the assignment lock; per-email and per-IP rate
    limits.
  - **Announcements** (`tests/announcements/`): every audience with and
    without a day, sent for real and checked against who got an email and
    who was listed unreachable (archived guests and invites, guests never
    invited and plus-ones never reached); the body escaped with its line
    breaks kept, From, Reply-To and the one button to the guest's own
    invitation; the history and its failure counts; the daily limit, also
    under racing sends; every validation code; a cancelled event 409;
    another tenant's event and a locked member's unassigned event 404; the
    flag. The cancellation email: who gets it, no button, the note
    escaped, recorded, failures reported while the cancel stands, a
    too-long note cancelling nothing, a second or racing cancel emailing
    nobody again, a completed event refused with `EVENT_ALREADY_HAPPENED`, never refused by the limit, a draft emailing nobody, and
    the flag off; when it can't be sent at all, the message (contact
    guests directly, never "send an announcement") and every guest not
    reached listed. The history's `dailyLimit` and `sentCount` counted
    from delivery rows (a crashed send). Guest email uniqueness (`tests/guest/guest-email-unique.test.ts`):
    RSVP's `PLUS_ONES_OVER_ALLOWANCE`, organiser add's `GUEST_EMAIL_TAKEN`,
    the unique index and each path's answer to a violation, and the
    migration refusing to run over duplicates.
  - **`FRONTEND_BASE_URL`** (`tests/config/`): a missing, blank or
    non-URL value refuses to load the app; share links are built by
    `frontendUrl`; no other file in `src/` reads the variable. Loading the
    rate limiters logs no express-rate-limit validation error
    (`ERR_ERL_KEY_GEN_IPV6`).
  - **Feature flags** (`tests/feature-flags/`): an unknown name fails
    startup, `/api/config/features` reflects the env, a switched-off
    feature's routes 404 for a tenant and work for a `SUPER_ADMIN`, the
    Paystack webhook and Event Pass purchase work with ticketing off,
    `/rsvp/validate` hides a saved design and offers no tickets, invite
    emails drop the design image, a paid or public event is 422 on create,
    update, publish and the wizard, an RSVP with a `ticketId` is refused,
    an older paid or public event stays editable, the import template is
    email-only with SMS off, an `EVENT_VENDOR` user is 422, an SMS-only guest is a reported failure
    on send, resend and reminder, and with SMS off a phone-only guest is
    422 on create, update and public registration, refused per row on
    import, and can't be left by an RSVP that removes the email. With
    `payments` off (`payments-off-routes.test.ts`,
    `payments-off-tier-wording.test.ts`): each payment route 404s, the
    read-only billing routes answer, a pass bought before the switch is
    confirmed by the webhook after it, and every tier refusal (events,
    public, paid ticketing on both sides, custom questions, guests, export,
    SMS three ways, Memory Hub three ways, vendors, the registration cap)
    keeps its status and code with no plan wording. With `memoryHubVideo`
    off (`tests/memory-hub/memory-hub-video-flag.test.ts`): video
    signatures 422 for guests and organisers, photos still sign, and
    guest-view's limits offer photos only.
  - **Error monitoring** (`tests/monitoring/`, `tests/system-health/`): one
    event carrying every forbidden value (body, cookies, Authorization,
    device/session/invite/share/team tokens, oobCode, OTP, password, emails
    and phones in every field) leaves the scrubber with none of them; a
    real Sentry client (sending nothing) captures no `HttpError` 4xx and
    does capture a 500 and an `HttpError` 503, with the user as id, role
    and tenant only; the 5xx safety net. System health: tenant and event
    admins 404, the 503 codes with health attached, both projects merged
    newest first, the filters, the 60-second cache, the token never in a
    response.
  - **Tier settings** (`tests/subscription/tier-capability-settings.test.ts`):
    public events, paid ticketing, custom RSVP questions and vendor priority
    placement each switched on for Spark and shown to change access; no
    config row keeps the old rule; the super admin screen saves them and
    refuses a non-boolean. `/api/tenants/me`'s `planSettings`
    (`tests/tenant/tenant-me-plan-settings.test.ts`): a SPARK setting
    changed shows in `/me`, no config row gives the enforcement fallback,
    and a switched-off feature's settings are left out.
  - **Safety limits** (`tests/safety-limits/`): venue capacity outside
    1–100,000 refused on create, update and materialize with nothing
    written; the guest ceiling on real 4,999-guest events (plus-ones
    counted) for add, restore, import, RSVP plus-ones and self-registration
    (view, FULL and PARTY_TOO_LARGE), after the plan's own limit; import
    refusing 2,001 rows before any row is checked, taking exactly 2,000, and
    the coded 413; the daily email limit on invitations, resends and
    reminders (nothing sent, no cooldown started), the rolling window, other
    events not counting, and two racing claims.
  - **Feedback and sharing permissions** (`tests/feedback/`): consent
    records append-only (a withdrawal is a new row, the repository has no
    update or delete, the database refuses an `UPDATE`) with the state
    following the latest record (seq breaking a same-millisecond tie);
    the wording stored per record and the history in order; a guest's
    opt-in off by default, recorded with its wording when true, videos
    refused, changed later through the token (their own photos only) and
    shown in guest-view; feedback only on completed events, the score and
    text rules, permissions recorded only on change, withdrawals; no photo
    selectable without the guest's opt-in (pending, rejected, archived,
    organiser, other-event photos refused too); another tenant's event and
    a locked member's unassigned event 404, a `SUPER_ADMIN` save 403; the
    logo's folder, URL and size; shareable = every condition, a guest's or
    organiser's withdrawal, a rejection or an archive each removing the
    photo; the list, the CSV (formula cells defused) and the download
    links; the super admin routes 404 for tenants; the request email's
    recipients and content, once per event even with two sweeps (or two
    requests) racing, never for cancelled, draft, future, too old,
    archived or answered events, nor with the flag off.
  - **The full event update** (`tests/event-full-update/full-update.test.ts`):
    a whole edit (event fields, days moved, added and removed, tickets,
    questions, program and items, the album's opening) lands at once, unchanged
    rows unwritten; removed rows archived, never deleted; two days swapping
    labels; a save with nothing changed writes nothing; each part's refusal
    (blank title, item off its day, a day moved without its item, a past
    day, no venue, capacity, the deadline, unknown ids, a duplicate label, a
    ticket price, an answer type, a missing item day, a malformed list,
    ticketing off, the custom-questions tier) leaves every row as it was; a
    database refusal mid-save rolls back what was written; another tenant
    and a locked member 404. The date rules on the per-part endpoints and
    materialize (`tests/validation/day-and-item-dates.test.ts`).
  - **Guest limits under concurrency** (`tests/guest/guest-limit-serialised.test.ts`):
    restore refused at the plan's limit (a plus-one allowed), and two adds
    or two imports racing for the last place: one lands, one is refused.
  - **Tier limits above 2 GB** (`tests/subscription/memory-hub-bytes-bigint.test.ts`):
    5 GB saved and returned as a number by the tier admin, its list and
    `/me`; an event holding 3 GB reported against it; the tier admin's
    422s for byte counts and guest export. `feedbackGiven` on the events
    list (`tests/feedback/events-list-feedback.test.ts`).
  - **Programs and invites under their URL** (`tests/tenant-scope/program-invite-url-scope.test.ts`):
    every `/program/:id` and `/invites/:id` route 404s, writing nothing, for
    the same tenant's other event's record, another tenant and a locked
    member's unassigned event; and works under the right URL. The wizard's
    draft question options held to the same rule (`tests/validation/bad-values-coded.test.ts`).
  - **Memory Hub routes under their URL** (`tests/memory-hub/memory-hub-url-scope.test.ts`):
    every `/:id` and `/:hubId` route 404s, writing nothing, for the same
    tenant's other event's hub, another hub's item and another tenant; and
    still works under the right URL. Coded 422s for bad question options,
    Memory Hub opening times and program visibility on every path
    (`tests/validation/bad-values-coded.test.ts`).
  - **Memory Hub download** (`tests/memory-hub/memory-hub-download.test.ts`):
    exactly the approved, live items by public id (never pending, rejected,
    archived or another folder), videos only with the flag on, the signed
    URL re-signed and its 30-minute expiry, safe zip names, 200 photos in
    three parts under the URL budget, the file-count and size budgets, the
    flag, other tenants and the assignment lock, and the per-event rate
    limit counting successes only.
  - **Memory Hub share-link gallery** (`tests/memory-hub/memory-hub-share-gallery.test.ts`):
    exactly the fields the page uses, with no uploader name (guest or
    organiser), host name or hub title/description anywhere; videos
    only with `memoryHubVideo` on; "This link isn't active." for an
    unknown token, and exactly the same 404 for a plan without Memory Hub
    (`findByTier` stubbed, so the shared tier rows are never touched). The
    600-per-IP limit itself is not tested. Guest-view's limits
    (`tests/memory-hub/memory-hub-guest-view-rate-limit.test.ts`): the
    hashed per-invite key, one invite refused past 60 while another on the
    same IP is not, and the IP refused after 100 failures; the same for
    the guest's Program tab (`tests/rsvp/rsvp-program-rate-limit.test.ts`).
    The public event view's 600 is not tested. Registration's limits
    (`tests/public-events/registration-rate-limit.test.ts`): a 300-person
    office's ~450 requests from one IP never refused, then refused past
    500; the ~180-request burst on one link never refused, then refused
    past 300; and the per-email limit.
  - **RSVP deadlines** (`tests/rsvp/rsvp-deadline-same-day.test.ts`): a
    deadline on a one-day event's own date (the day ending 14:00) accepted
    by update, the full update and materialize, the day after refused; a
    date-only deadline stored as the end of its day, and today's not "in
    the past" at create; a deadline of today stored as its midnight still
    open to RSVP submit and the guest page, yesterday's closed; reminders
    through the end of the deadline's day.
  - **Registration status codes**
    (`tests/public-events/registration-status-codes.test.ts`): each
    `registration.code` with its message (NOT_PUBLISHED through the
    organiser's settings), open with a deadline of today, and a closing date
    on the deadline's own day in either form.
  - **Questions at registration**
    (`tests/public-events/registration-answers.test.ts`): the view lists
    the live questions as RSVP does; answers stored on the registrant's
    invite and shown by the guest details and the export; a missing
    required answer (`RSVP_ANSWER_REQUIRED`, at RSVP too), an unknown or
    archived or other event's field (`RSVP_ANSWER_UNKNOWN_FIELD`), a wrong
    type (`RSVP_ANSWER_INVALID`) and a malformed list each refused, creating
    no one; a DROPDOWN answer outside its options (`RSVP_ANSWER_INVALID`)
    and the same question twice (`RSVP_ANSWER_DUPLICATE`, was a 500)
    refused at registration and at RSVP alike; a repeat registration stores
    no second answers; a CHECKBOX answer other than "true" or "false"
    refused at both, and a CHECKBOX answer not sent storing and returning
    nothing.
  - **Guest import, comments and unreadable files**
    (`tests/guest/guest-import-unreadable.test.ts`): a real Excel workbook
    with a note in the layout that crashed (`fixtures/guest-list-with-note.xlsx`,
    absolute comment Targets) imports every guest, as do comments in a
    subfolder and a renamed VML drawing, and Excel's own layout still does;
    a non-workbook, a damaged workbook, a zip with no sheets and a broken
    CSV are each 422 `GUEST_IMPORT_UNREADABLE_FILE` with nothing checked or
    written; a small upload unpacking just past either cap and inside the
    other (one part past 3 MB, or parts under it together past 4 MB) is the
    same 422 with nothing written, while a real 2,000-row list unpacks well
    under them and imports every guest; the template has no comments, its notes are on an Instructions
    sheet after Guests, and it imports as-is. Time and memory for 300 and
    2,000 rows: `tests/perf/import-timing.test.ts`, opt-in
    (`MEASURE_IMPORT_TIMING=1`).
  - **Archived-event media retention**
    (`tests/media-retention/media-retention.test.ts`, Cloudinary's
    `destroyAssets` mocked): archiving records `archivedAt`; at 29 days
    nothing is deleted, past 30 every item's file goes (any status, each by
    its resource type), the rows are kept purged and archived, and the event
    and its cover stay; a restore before the purge cancels it, one after
    brings the event back without its media and a purged item can't be
    restored; two sweeps racing delete each file once, in one purge and one
    attempt, and two attempts at one purge at the same moment run once (the
    lease; the two-sweep test alone doesn't catch a broken lease, since the
    sweep skips a leased purge before taking it); a refused item, or a whole refused batch, is recorded and only
    it retried by the next sweep; the reminder once, through the layout,
    with its button, also with two sweeps racing, never for a restored event,
    one with nothing to download or one not yet due; the super admin purge
    recorded with who, the global 404 for a tenant admin, an event admin and
    another tenant, `EVENT_NOT_ARCHIVED` and `MEDIA_PURGE_ALREADY_STARTED`;
    the migration's backfill giving an old archived event the migration's
    time, so its first sweep purges and reminds nothing; restoring past the
    plan's event limit 403 `EVENT_LIMIT_REACHED` (free-trial wording with
    payments off), as creating is; the archived list, detail, Memory Hub
    and download readable with the dates, a write still 404, another tenant
    404; an archived event private to its guests at once (the share link
    byte for byte an unknown one's 404, guest-view `{ available: false }`,
    upload signature and save 404 in neutral words with a late upload's
    file removed, a file in another event's folder never touched, the
    organiser still reading it); `archiveMediaPurge` off: no reminder, no
    purge, no retry, the super admin 422 `ARCHIVE_MEDIA_PURGE_OFF`, no
    `mediaPurgeAt`, `archivedAt` still recorded, and back on, the work done;
    off past the 30 days and then on: the reminder first, giving a date a
    week on, which `mediaPurgeAt` reports, nothing deleted six days later,
    purged after seven; an event with nothing to download purged at 30 days
    with no reminder; the guest's invitation for an archived event 410 "This
    event is no longer available." with nothing of the event in it, an RSVP
    change refused with nothing written, the Program tab unavailable, and
    restoring opening it again. Each guarantee was shown to fail with its
    fix reverted (2026-10-26).

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
  visibility, guest-facing day venues, RSVP contact editing, the public
  registration page (each link and registration state, open days,
  plus-ones up to the allowance, refusals placed by code, never reading
  a token from the response), the organiser's registration settings panel
  (status at a glance, the cap against the plan's limit, the closing
  date, domains, open days, sending only what changed), registrants in
  the public control centre's guest list and its WhatsApp share, and
  plus-one allowances on Add Guest, guest details and the guest list. Most screens and
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
  dropped (see "Venue"), but `/rsvp/validate`'s `event.location`/`address`
  and coordinates, filled from the first day's venue, are still sent. The current frontend reads
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

---

## 9. Known decisions for later

Decided, not yet built. Do not build them early, and do not build
anything that contradicts them.

- **Cover photo vs invitation design:** after the pilot, the cover photo
  becomes the event's image OUTSIDE the event (invite emails, and share
  previews on WhatsApp and social media), and the invitation design is
  what guests see INSIDE the event, on their page. Each has one job; they
  never compete.
