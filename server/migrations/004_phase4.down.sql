-- Rollback Phase 4
DROP TABLE IF EXISTS message_reactions;
ALTER TABLE messages DROP COLUMN IF EXISTS reply_to_id;
