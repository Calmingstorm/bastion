DROP INDEX IF EXISTS idx_attachments_message_position;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_position_nonnegative;
ALTER TABLE attachments DROP COLUMN IF EXISTS position;
