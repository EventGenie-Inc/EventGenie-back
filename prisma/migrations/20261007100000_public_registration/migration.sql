-- Public events and self-registration.
--
-- Event: the organiser's registration settings (allowed email domains, a
-- cap, a closing date, and the plus-one allowance given to registrants).
-- Every default leaves an existing public event behaving as before: anyone
-- may register, no cap of its own (the plan's guest limit still applies),
-- closing at the RSVP deadline, no plus-ones.
ALTER TABLE "Event"
  ADD COLUMN "registrationEmailDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "registrationCap" INTEGER,
  ADD COLUMN "registrationClosesAt" TIMESTAMP(3),
  ADD COLUMN "registrationPlusOnesAllowed" INTEGER NOT NULL DEFAULT 0;

-- EventDay: which days a registrant may choose. Every existing day is open.
ALTER TABLE "EventDay" ADD COLUMN "openForRegistration" BOOLEAN NOT NULL DEFAULT true;

-- Guest: marks a guest who registered themselves.
ALTER TABLE "Guest" ADD COLUMN "selfRegisteredAt" TIMESTAMP(3);

-- Backfill: guests created by the earlier registration endpoint are the
-- primary guests (never plus-ones) whose invite was written by its actor,
-- 'guest-self-registration' (event-public.service.ts's GUEST_ACTOR). Their
-- creation time is when they registered.
UPDATE "Guest" g
SET "selfRegisteredAt" = g."createdAt"
WHERE g."hostGuestId" IS NULL
  AND g."selfRegisteredAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Invite" i
    WHERE i."guestId" = g."id" AND i."createdBy" = 'guest-self-registration'
  );
