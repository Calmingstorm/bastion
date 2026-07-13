-- Removes the direct-DM uniqueness invariant. This CANNOT reconstruct the
-- duplicate channels the up migration merged away -- the de-duplication is
-- one-way. Down only drops the schema so the application can run against the
-- prior version again.
DROP INDEX IF EXISTS idx_channels_dm_key;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_dm_key_valid;
ALTER TABLE channels DROP COLUMN IF EXISTS dm_user_hi;
ALTER TABLE channels DROP COLUMN IF EXISTS dm_user_lo;
