-- Persist the order in which files were attached to a message. PostgreSQL's
-- transaction timestamp is shared by every attachment inserted in one upload,
-- so created_at cannot provide the realtime upload order when history reloads.
ALTER TABLE attachments ADD COLUMN position INTEGER;

-- Give existing attachments a deterministic order before making the ordinal
-- mandatory. UUID is the stable tie-breaker for legacy same-timestamp rows whose
-- original upload order was never persisted and therefore cannot be recovered.
WITH ranked AS (
    SELECT id,
           (ROW_NUMBER() OVER (
               PARTITION BY message_id
               ORDER BY created_at ASC, id ASC
           ) - 1)::INTEGER AS position
      FROM attachments
)
UPDATE attachments AS a
   SET position = ranked.position
  FROM ranked
 WHERE a.id = ranked.id;

ALTER TABLE attachments
    ALTER COLUMN position SET NOT NULL,
    ADD CONSTRAINT attachments_position_nonnegative CHECK (position >= 0);

CREATE UNIQUE INDEX idx_attachments_message_position
    ON attachments(message_id, position);
