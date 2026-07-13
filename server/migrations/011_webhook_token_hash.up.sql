-- Store webhook tokens as a SHA-256 digest instead of plaintext. The token is a
-- 192-bit CSPRNG secret, so SHA-256 (no salt/argon2) is sufficient and keeps the
-- public execute path cheap. token_hint holds the last 8 characters for display.
ALTER TABLE webhooks
    ADD COLUMN token_hash BYTEA,
    ADD COLUMN token_hint VARCHAR(8);

UPDATE webhooks
SET token_hash = digest(token, 'sha256'),
    token_hint = RIGHT(token, 8);

ALTER TABLE webhooks
    ALTER COLUMN token_hash SET NOT NULL,
    ALTER COLUMN token_hint SET NOT NULL;

CREATE UNIQUE INDEX idx_webhooks_token_hash ON webhooks(token_hash);

ALTER TABLE webhooks DROP COLUMN token;
