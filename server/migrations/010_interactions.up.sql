-- Application commands (slash commands + context menus)
CREATE TABLE application_commands (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    bot_id      UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    type        SMALLINT NOT NULL DEFAULT 1,  -- 1=CHAT_INPUT, 2=USER, 3=MESSAGE
    name        VARCHAR(32) NOT NULL,
    description VARCHAR(100) NOT NULL DEFAULT '',
    options     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, bot_id, name)
);

CREATE INDEX idx_app_commands_server ON application_commands(server_id);
CREATE INDEX idx_app_commands_bot ON application_commands(bot_id);

-- Interaction tokens (short-lived, for bot callbacks)
CREATE TABLE interaction_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    command_id      UUID NOT NULL REFERENCES application_commands(id) ON DELETE CASCADE,
    bot_id          UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    invoker_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           TEXT NOT NULL UNIQUE,
    options_data    JSONB,
    target_id       UUID,  -- for USER/MESSAGE context menu commands
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interaction_tokens_token ON interaction_tokens(token);
CREATE INDEX idx_interaction_tokens_expires ON interaction_tokens(expires_at);
