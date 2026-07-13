-- Fully reversible: the up migration only records provenance and adds the key
-- columns/index; it never merges or deletes channels.
DROP INDEX IF EXISTS idx_channels_dm_key;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_dm_kind_valid;
ALTER TABLE channels DROP COLUMN IF EXISTS dm_kind;
ALTER TABLE channels DROP COLUMN IF EXISTS dm_user_hi;
ALTER TABLE channels DROP COLUMN IF EXISTS dm_user_lo;
