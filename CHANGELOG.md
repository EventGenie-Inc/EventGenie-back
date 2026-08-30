# Changelog

All notable changes to EventGenie. Newest first.

Format is loosely [Keep a Changelog](https://keepachangelog.com/).
Versioning is by feature milestone rather than semver — nothing is
publicly released yet.

---

## [Unreleased]

### Next up
- Ticketed events and payment gateway integration
- Announcements (per-event, shown on the guest RSVP page after RSVP)
- Guest self-registration on public event RSVP (**not built** — public
  event share links currently resolve to nothing)

---

## Event Control Center — August 2026

The organiser's operational screen: build a guest list, import in bulk,
send invitations, manage the event lifecycle.

### Added
- **Bulk import engine** — `.xlsx`/`.csv` upload, per-row validation, and
  a results report giving the actual spreadsheet row number and a
  specific reason for every failure
- **Event-specific import template** — generated per event with that
  event's real day labels, so a spreadsheet cannot fail on a mismatched
  day value
- **SMS engine and Email engine** — separate, domain-agnostic dispatch
  units under one bulk-invite orchestrator; reusable for announcements
  and reminders
- **Bulk invite sending** — guest selection, per-guest routing by
  contact type, aggregated success/failure reporting
- Single-invite resend, reusing the original token
- Public event share link endpoint
- Manual single-guest creation alongside the import engine
- Guest archive **and restore**
- **Publish action** — `DRAFT` to `PUBLISHED`, with validation
- **Cancel action** — stored, irreversible, available on draft,
  published, and completed events
- **Derived completion** — `COMPLETED` computed at read time from the
  last event day passing; no scheduler, no stored state, no drift
- `SmsSendLog` for monthly quota accounting

### Changed
- `Guest.firstName` / `surname` are now nullable — a guest imported by
  phone alone supplies their name at RSVP time
- `Guest` gained a direct `eventId`, replacing transitive lookup through
  `Invite` and simplifying tenant scoping
- Archiving a guest now cascades to their invites; invites can also be
  archived independently
- `EventDay.label` is unique per event (case-insensitive at the
  application layer), so import day-matching is unambiguous
- Guest table columns are separated and constrained — long emails no
  longer bleed into adjacent columns

### Fixed
- **`UpdateEventDto` accepted a `status` field** written straight through
  with no validation, allowing anyone to publish or unpublish an event
  via the generic update route and bypass every lifecycle guard.
  `Event.status` now has exactly one writer.
- Public RSVP endpoints did not check event status — a guest could RSVP
  to a cancelled event
- Backend error messages were silently discarded for any real HTTP error
  status, so specific, useful messages never reached the user
- Prisma transaction timeout on imports of 50+ rows — rewritten from
  3xN round-trips to 4 queries total, regardless of row count

### Security
- Tenant isolation on `guest`, `invite`, and `attendance` — all three had
  no scoping and were reachable cross-tenant by id
- Server-side visibility checks on guest create and import

---

## Codebase Stabilisation — August 2026

A full audit before building further. Findings were split: fix what is
live and reachable, record and defer what is dormant.

### Security
- **Privilege escalation** — any `TENANT_ADMIN` could set a user's role
  to `SUPER_ADMIN`, including their own, taking over the entire platform
- **Tenant injection** — `userService.create` trusted a client-supplied
  `tenantId`, allowing users to be created inside another tenant
- Nobody, including a `SUPER_ADMIN`, can now change their own role
- Tenant isolation on `user` and `event-day`
- **Server-side subscription tier enforcement** — previously a frontend
  `effect()` was the only gate in the entire system; the API could be
  called directly to bypass every tier limit
- Angular patched to 21.2.21, closing an XSS sanitisation bypass; audit
  went from 30 vulnerabilities to zero

### Fixed
- **Reactive-401 interceptor deadlock** — when a session expired outside
  the proactive refresh window, the recovery path sent the same expired
  token to the refresh endpoint, was rejected identically, and awaited a
  promise that could only settle via the request it was blocking. The
  app hung with no error and no logout. Deterministic, not rare.
- `Tenant.reactivate()` — two stacked bugs: its lookup filtered out
  archived tenants so it could never find its target, and its transaction
  never cleared `isArchived` even when it did
- Suspended users vanished from the only list that could restore them
- SPARK tier downgrade left orphaned paid ticket rows
- Editing the Memory Hub on an event without one silently no-opped while
  reporting success

### Added
- Deferred Technical Debt Register — every known issue tied to the
  feature whose development should trigger it

---

## Event Space — August 2026

### Added
- Events list with archive, edit, and Control Center actions
- **Four-step creation wizard** — basic info and days, RSVP form builder,
  digital program and Memory Hub config, invitation template
- **Draft persistence** — wizard state autosaves to a single `EventDraft`
  record and materialises into real relational rows only on completion,
  so an interrupted setup is never lost
- Edit mode reusing the same wizard against real records, no draft
- Subscription tier gating in the wizard
- `GET /api/tenants/me` for self-service tier lookup

### Security
- Tenant isolation on `event` — `findById`, `update`, and `archive` were
  all reachable cross-tenant by id

---

## Authentication — August 2026

### Added
- Firebase email/password authentication
- Email OTP as a second factor, with a live expiry countdown
- Session JWT with silent refresh before expiry
- Forgot password via Resend, using Firebase-generated reset links inside
  a branded email
- Dedicated `/reset-password` page validating the code before showing the
  form
- **"Keep me signed in"** — opt-in, `sessionStorage`-backed, surviving a
  refresh but not a tab close
- Route preservation — deep-linking while logged out returns you to the
  requested page after login
- Show/hide password toggle across all five password fields
- Confirm-password field on registration

### Security
- CORS locked to an explicit allowlist
- Rate limiting on `forgot-password` (per-IP and per-email),
  `request-otp`, and `verify-otp`
- **`trust proxy` configured** — without it, every request behind Render's
  proxy resolved to the same IP, silently turning per-IP rate limits into
  one shared bucket for the entire platform
- `checkRevoked` on Firebase token verification, so a suspended user's
  token is rejected immediately
- Auth errors converted from plain `Error` to `HttpError`, so real status
  codes reach the client instead of masked 500s
- **Replaced a `localStorage`-based stopgap auth service** left over from
  earlier scaffolding

---

## Super Admin — August 2026

### Added
- Tenant list and detail views
- Tenant suspend and reactivate, cascading to all users under the tenant
- Individual user suspend and reactivate
- Subscription tier configuration and availability toggle
- Firebase account disable/enable mirroring Postgres state, keeping the
  same UID so reactivation needs no re-registration

### Fixed
- `user.reactivate()` could never find an archived user, so the feature
  was dead on arrival

---

## Foundations — July/August 2026

### Added
- Public landing page, features page, pricing page
- Privacy policy and terms of service
- Backend domain model — 20+ entities covering events, guests, invites,
  attendance, RSVP fields and responses, digital programs, tickets,
  vendors, and the Memory Hub
- Multi-tenant architecture with role-based access control
- Dev seed script with safety guards preventing any production run

### Infrastructure
- Domain `eventgenie.org.za` registered and configured
- Resend sending domain verified
- Twilio South African number (compliance approval pending)
- Cloudinary configured for Memory Hub storage
- Dev and prod environments across Render and Firebase Hosting
