-- Invariant: unread/read comparisons use ONE server-owned total order tied to
-- the write and the acknowledgment. Wall clocks cannot do this job: message
-- createdAt is bot-suppliable (a presentation timestamp), and application
-- emission times live on a different clock than PostgreSQL's ack times. `seq`
-- is assigned by the database at insert and is not part of any request surface.

CREATE SEQUENCE IF NOT EXISTS messages_seq;

ALTER TABLE messages ADD COLUMN seq BIGINT;

-- Backfill existing history in channel-presentation order (created_at, then id
-- as a stable tiebreak), so coverage comparisons against pre-migration acks
-- match what users had actually scrolled past.
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
    FROM messages
)
UPDATE messages m SET seq = o.rn FROM ordered o WHERE m.id = o.id;

SELECT setval('messages_seq', COALESCE((SELECT MAX(seq) FROM messages), 0) + 1, false);

ALTER TABLE messages ALTER COLUMN seq SET DEFAULT nextval('messages_seq');
ALTER TABLE messages ALTER COLUMN seq SET NOT NULL;

-- The read watermark: the seq of the acknowledged message. NULL = never acked
-- (or acked before this migration ran and the message has since been deleted).
ALTER TABLE read_states ADD COLUMN last_read_seq BIGINT;

UPDATE read_states rs
SET last_read_seq = m.seq
FROM messages m
WHERE m.id = rs.last_message_id;
