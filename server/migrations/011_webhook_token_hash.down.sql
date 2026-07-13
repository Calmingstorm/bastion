-- The original plaintext tokens cannot be recovered from a SHA-256 digest, so a
-- rollback rotates every webhook to a fresh token. Existing webhook URLs stop
-- working and external integrations must be updated with the new tokens.
ALTER TABLE webhooks ADD COLUMN token TEXT;

UPDATE webhooks
SET token = 'whk_' || encode(gen_random_bytes(24), 'hex');

ALTER TABLE webhooks ALTER COLUMN token SET NOT NULL;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_token_key UNIQUE (token);

ALTER TABLE webhooks
    DROP COLUMN token_hash,
    DROP COLUMN token_hint;
