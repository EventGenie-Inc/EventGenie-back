# EventGenie — Steering

Conventions every contributor and AI coding agent must follow.

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

Two documented exceptions: `Attendance` (a fact record — it happened or
it did not) and `EventDraft` (transient wizard state, deleted on
materialisation).

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

### Session and tokens

Session JWTs live in memory, plus `sessionStorage` when the user opts
into "keep me signed in". **Never `localStorage`.**

All storage access is isolated inside `AuthService`. No guard,
interceptor, or component touches it directly — that boundary is what
made removing an earlier bad implementation a single-file change.

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
their list before going live. Memory Hub access is governed solely by
`opensAt` and is independent of event status.

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
- **Automated test coverage is thin.** Backend has none; frontend has
  interceptor regression tests only.
- **Twilio SMS is blocked** pending compliance approval. Everything
  except real delivery is testable.
- A deferred technical debt register tracks tenant-isolation and
  restore-path gaps in modules that have no UI yet. **Read the relevant
  section before building any feature that makes them reachable** —
  fixing them inside the feature build is far cheaper than retrofitting.
