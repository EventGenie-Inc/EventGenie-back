-- Multi-select questions: a guest picks one or more of a question's
-- options (src/modules/rsvp/rsvp-answers.util.ts).
--
-- Additive only: a new value on RsvpFieldType. A MULTI_SELECT question's
-- options are stored like a DROPDOWN's (RsvpField.options, a JSON-encoded
-- list of text), and its answer in RsvpResponse.value as a JSON-encoded
-- list of the chosen options. Nothing existing is renamed, dropped or
-- rewritten: DROPDOWN keeps its name and every saved question and answer
-- reads exactly as before.
--
-- ALTER TYPE ... ADD VALUE runs inside the migration's transaction, which
-- Postgres allows (12+) as long as the new value isn't used in the same
-- transaction; nothing here uses it.

-- AlterEnum
ALTER TYPE "RsvpFieldType" ADD VALUE 'MULTI_SELECT';
