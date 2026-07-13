-- F1: replace the O(N)-Argon2 bot-auth scan with an indexed SHA-256 lookup.
--
-- Bot tokens are 192-bit CSPRNG bearer secrets ("bot_" + 48 hex), so a
-- deterministic SHA-256 digest is a safe at-rest lookup key: an attacker with
-- read access to this column cannot feasibly invert it. token_lookup CANNOT be
-- backfilled here -- existing rows store only the salted Argon2 hash and the
-- plaintext token is unrecoverable. Legacy rows (token_lookup IS NULL) are
-- healed lazily on their next successful authentication; token_hash stays until
-- a later cleanup migration drops it once no legacy rows remain.

ALTER TABLE bots ADD COLUMN token_lookup BYTEA;

-- A digest is always exactly 32 bytes when present.
ALTER TABLE bots ADD CONSTRAINT bots_token_lookup_len
    CHECK (token_lookup IS NULL OR octet_length(token_lookup) = 32);

-- Fast path: at most one bot per digest. Partial so the many-NULL legacy rows
-- neither collide on uniqueness nor bloat the index.
CREATE UNIQUE INDEX idx_bots_token_lookup ON bots (token_lookup)
    WHERE token_lookup IS NOT NULL;

-- Transitional selector: narrow legacy Argon2 candidates to the tiny bucket
-- sharing the presented token's hint, so an unmatched token never scans the
-- whole legacy set. Dropped together with token_hash once healing completes.
CREATE INDEX idx_bots_legacy_hint ON bots (token_hint)
    WHERE token_lookup IS NULL;
