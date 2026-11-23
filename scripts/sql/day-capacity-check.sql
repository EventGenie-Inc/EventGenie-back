-- ─────────────────────────────────────────
--  DAY CAPACITY CHECK — read-only. Run on staging and production after the
--  20261125090000_event_day_capacity migration. Every statement is a
--  SELECT: nothing here changes anything.
--
--  "Attending" a day is day-capacity.util.ts's rule: an Attendance row for
--  that day whose invite is live and ACCEPTED and whose guest isn't
--  awaiting approval. Plus-ones have their own invite and Attendance rows,
--  so they count. Only live events and live days are listed. Note: before
--  hotfix/day-capacity, a "yes" to a single-day invitation sent without day
--  ids recorded no day, so such guests are not counted here (see 4).
-- ─────────────────────────────────────────

-- 1. Multi-day events whose live VENUE days are not all at the same venue
--    (name and address compared ignoring case and surrounding spaces). The
--    migration copied ONE event-level number to every venue day, which is
--    probably wrong for at least one of them: ask the organiser to check
--    each day's capacity. Online days are left out (they have no capacity).
SELECT
  e."id"                                   AS event_id,
  e."name"                                 AS event_name,
  e."tenantId"                             AS tenant_id,
  e."capacity"                             AS old_event_capacity,
  COUNT(*)                                 AS venue_days,
  COUNT(DISTINCT lower(btrim(coalesce(d."location", ''))) || '|' || lower(btrim(coalesce(d."address", '')))) AS distinct_venues,
  string_agg(d."label" || ' (' || to_char(d."date", 'YYYY-MM-DD') || '): '
             || coalesce(d."location", '?') || ', ' || coalesce(d."address", '?')
             || ' cap ' || coalesce(d."capacity"::text, 'none'),
             E'\n' ORDER BY d."date", d."createdAt") AS days
FROM "Event" e
JOIN "EventDay" d ON d."eventId" = e."id" AND d."isArchived" = false
WHERE e."isArchived" = false
  AND d."locationType" IS DISTINCT FROM 'ONLINE'
GROUP BY e."id"
HAVING COUNT(DISTINCT lower(btrim(coalesce(d."location", ''))) || '|' || lower(btrim(coalesce(d."address", '')))) > 1
ORDER BY e."name";

-- 2. Days already over capacity (organisers will see a warning): more
--    people attending than the day's capacity. Capacity is informational:
--    nothing is refused and nobody is removed; the event detail warns the
--    organiser, who may want to raise the number.
SELECT
  e."id"           AS event_id,
  e."name"         AS event_name,
  e."tenantId"     AS tenant_id,
  d."id"           AS event_day_id,
  d."label"        AS day_label,
  d."date"         AS day_date,
  d."capacity"     AS capacity,
  COUNT(a."id")    AS attending
FROM "EventDay" d
JOIN "Event" e       ON e."id" = d."eventId" AND e."isArchived" = false
JOIN "Attendance" a  ON a."eventDayId" = d."id"
JOIN "Invite" i      ON i."id" = a."inviteId" AND i."isArchived" = false AND i."status" = 'ACCEPTED'
JOIN "Guest" g       ON g."id" = i."guestId" AND g."pendingApproval" = false
WHERE d."isArchived" = false
  AND d."capacity" IS NOT NULL
GROUP BY e."id", d."id"
HAVING COUNT(a."id") > d."capacity"
ORDER BY e."name", d."date";

-- 3. Events whose old capacity was NOT copied because it is outside 1 to
--    100,000 (stored before that limit existed). Their days are unlimited
--    now; ask the organiser for the real number.
SELECT e."id" AS event_id, e."name" AS event_name, e."tenantId" AS tenant_id, e."capacity" AS old_event_capacity
FROM "Event" e
WHERE e."isArchived" = false
  AND e."capacity" IS NOT NULL
  AND e."capacity" NOT BETWEEN 1 AND 100000
ORDER BY e."name";

-- 4. Accepted invitations to a single live day that record no day at all:
--    a "yes" sent without day ids before hotfix/day-capacity (since then,
--    accepting a single-day invitation records that day). These guests and
--    their plus-ones are attending but missing from that day's count, so its
--    attendingCount and warnings read low. Read-only: it only says how many.
SELECT
  e."id"        AS event_id,
  e."name"      AS event_name,
  e."tenantId"  AS tenant_id,
  d."id"        AS event_day_id,
  d."label"     AS day_label,
  COUNT(*)      AS accepted_invites_without_a_day
FROM "Invite" i
JOIN "Guest" g     ON g."id" = i."guestId" AND g."pendingApproval" = false
JOIN "Event" e     ON e."id" = i."eventId" AND e."isArchived" = false
JOIN "InviteEventDay" ied ON ied."inviteId" = i."id"
JOIN "EventDay" d  ON d."id" = ied."eventDayId" AND d."isArchived" = false
WHERE i."isArchived" = false
  AND i."status" = 'ACCEPTED'
  AND NOT EXISTS (SELECT 1 FROM "Attendance" a WHERE a."inviteId" = i."id")
  AND (
    SELECT COUNT(*) FROM "InviteEventDay" x
    JOIN "EventDay" xd ON xd."id" = x."eventDayId" AND xd."isArchived" = false
    WHERE x."inviteId" = i."id"
  ) = 1
GROUP BY e."id", d."id"
ORDER BY e."name", d."date";
