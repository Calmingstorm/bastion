-- Webhooks & Bot integrations

ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE webhooks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    creator_id  UUID NOT NULL REFERENCES users(id),
    name        VARCHAR(100) NOT NULL,
    avatar_url  TEXT,
    token       TEXT NOT NULL UNIQUE,
    user_id     UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_webhooks_server ON webhooks(server_id);
CREATE INDEX idx_webhooks_channel ON webhooks(channel_id);

CREATE TABLE bots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    creator_id  UUID NOT NULL REFERENCES users(id),
    user_id     UUID NOT NULL UNIQUE REFERENCES users(id),
    token_hash  TEXT NOT NULL,
    token_hint  VARCHAR(12) NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bots_server ON bots(server_id);
