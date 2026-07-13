DROP INDEX IF EXISTS idx_bots_legacy_hint;
DROP INDEX IF EXISTS idx_bots_token_lookup;
ALTER TABLE bots DROP CONSTRAINT IF EXISTS bots_token_lookup_len;
ALTER TABLE bots DROP COLUMN IF EXISTS token_lookup;
