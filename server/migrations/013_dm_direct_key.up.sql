-- F23: give direct (1:1) DMs a database-enforced identity so concurrent creates
-- cannot produce duplicate channels. A 1:1 DM is identified by the canonical
-- sorted pair of its two members; group DMs (>=3 members) stay unkeyed (NULL).
--
-- This migration is intentionally one-way: it de-duplicates existing direct DMs
-- by merging every duplicate into the oldest channel, then installs the unique
-- invariant. The down migration removes the invariant but cannot reconstruct the
-- channels that were merged away. Run the read-only preflight and take a backup
-- before applying in production.

ALTER TABLE channels ADD COLUMN dm_user_lo UUID;
ALTER TABLE channels ADD COLUMN dm_user_hi UUID;

-- Classify existing data by member count: exactly two distinct members on a
-- serverless 'dm' channel is a direct DM. Group DMs always have >=3 members
-- (creator + 2+ recipients), so this cannot misclassify a real group.
-- UUID has no MIN/MAX aggregate, but its canonical text sorts identically to
-- its byte order, so aggregate on ::text and cast back for the canonical pair.
CREATE TEMP TABLE _dm_pair AS
SELECT c.id AS channel_id, c.created_at,
       MIN(m.user_id::text)::uuid AS user_lo, MAX(m.user_id::text)::uuid AS user_hi
FROM channels c
JOIN dm_members m ON m.channel_id = c.id
WHERE c.type = 'dm' AND c.server_id IS NULL
GROUP BY c.id, c.created_at
HAVING COUNT(*) = 2 AND COUNT(DISTINCT m.user_id) = 2;

-- Winner per pair = oldest by created_at, id as the deterministic tie-break.
CREATE TEMP TABLE _dm_map AS
SELECT p.channel_id AS loser_id, w.winner_id
FROM _dm_pair p
JOIN (
    SELECT DISTINCT ON (user_lo, user_hi)
           user_lo, user_hi, channel_id AS winner_id
    FROM _dm_pair
    ORDER BY user_lo, user_hi, created_at ASC, channel_id ASC
) w ON p.user_lo = w.user_lo AND p.user_hi = w.user_hi
WHERE p.channel_id <> w.winner_id;

-- Messages move wholesale; their ids, replies, attachments, and reactions hang
-- off message_id and survive naturally.
UPDATE messages SET channel_id = m.winner_id
FROM _dm_map m WHERE messages.channel_id = m.loser_id;

-- Pins repoint with their messages. message_id is globally unique and its
-- message was in the loser, so (winner, message_id) cannot already exist.
UPDATE message_pins SET channel_id = m.winner_id
FROM _dm_map m WHERE message_pins.channel_id = m.loser_id;

-- read_states: two split read histories cannot be one cursor perfectly, so the
-- conservative policy is to keep the later last_read_at (most-recently-read).
UPDATE read_states w
SET last_read_at = GREATEST(w.last_read_at, l.last_read_at),
    last_message_id = CASE WHEN l.last_read_at > w.last_read_at
                           THEN l.last_message_id ELSE w.last_message_id END
FROM read_states l
JOIN _dm_map m ON l.channel_id = m.loser_id
WHERE w.channel_id = m.winner_id AND w.user_id = l.user_id;
-- Move loser read_states with no winner counterpart, then drop the merged rest.
UPDATE read_states l
SET channel_id = m.winner_id
FROM _dm_map m
WHERE l.channel_id = m.loser_id
  AND NOT EXISTS (SELECT 1 FROM read_states w
                  WHERE w.channel_id = m.winner_id AND w.user_id = l.user_id);
DELETE FROM read_states l USING _dm_map m WHERE l.channel_id = m.loser_id;

-- dm_members: winner already holds both users. Keep the earliest created_at and
-- treat the membership as open if any copy was open for that user.
UPDATE dm_members w
SET created_at = LEAST(w.created_at, l.created_at),
    closed_at = CASE WHEN w.closed_at IS NULL OR l.closed_at IS NULL
                     THEN NULL ELSE GREATEST(w.closed_at, l.closed_at) END
FROM dm_members l
JOIN _dm_map m ON l.channel_id = m.loser_id
WHERE w.channel_id = m.winner_id AND w.user_id = l.user_id;
DELETE FROM dm_members l USING _dm_map m WHERE l.channel_id = m.loser_id;

-- Server-scoped tables should never reference a DM channel, but the schema
-- permits it, so repoint defensively rather than let a delete cascade them away.
UPDATE channel_permission_overrides SET channel_id = m.winner_id
FROM _dm_map m WHERE channel_permission_overrides.channel_id = m.loser_id;
UPDATE webhooks SET channel_id = m.winner_id
FROM _dm_map m WHERE webhooks.channel_id = m.loser_id;
UPDATE interaction_tokens SET channel_id = m.winner_id
FROM _dm_map m WHERE interaction_tokens.channel_id = m.loser_id;

-- Losers now have no dependent rows.
DELETE FROM channels c USING _dm_map m WHERE c.id = m.loser_id;

DROP TABLE _dm_pair;
DROP TABLE _dm_map;

-- Backfill the key on every surviving direct DM (recomputed post-dedup).
UPDATE channels c
SET dm_user_lo = p.user_lo, dm_user_hi = p.user_hi
FROM (
    SELECT c.id AS channel_id,
           MIN(m.user_id::text)::uuid AS user_lo, MAX(m.user_id::text)::uuid AS user_hi
    FROM channels c
    JOIN dm_members m ON m.channel_id = c.id
    WHERE c.type = 'dm' AND c.server_id IS NULL
    GROUP BY c.id
    HAVING COUNT(*) = 2 AND COUNT(DISTINCT m.user_id) = 2
) p
WHERE c.id = p.channel_id;

-- A direct key is valid only as a canonical pair on a serverless dm channel.
ALTER TABLE channels ADD CONSTRAINT channels_dm_key_valid CHECK (
    (dm_user_lo IS NULL AND dm_user_hi IS NULL)
    OR (dm_user_lo IS NOT NULL AND dm_user_hi IS NOT NULL
        AND dm_user_lo < dm_user_hi
        AND type = 'dm' AND server_id IS NULL)
);

CREATE UNIQUE INDEX idx_channels_dm_key ON channels (dm_user_lo, dm_user_hi)
    WHERE dm_user_lo IS NOT NULL;
