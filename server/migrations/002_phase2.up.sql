-- Phase 2: Core Chat Features

-- Server Invites
CREATE TABLE server_invites (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id  UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES users(id),
    code       VARCHAR(16) UNIQUE NOT NULL,
    max_uses   INT,
    uses       INT DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_invites_code ON server_invites(code);
CREATE INDEX idx_invites_server ON server_invites(server_id);

-- DM support: add type column to channels, make server_id nullable
ALTER TABLE channels ADD COLUMN type VARCHAR(10) DEFAULT 'server' NOT NULL;
ALTER TABLE channels ALTER COLUMN server_id DROP NOT NULL;

CREATE TABLE dm_members (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_dm_members_user ON dm_members(user_id);

-- File attachments
CREATE TABLE attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    stored_name  TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    url          TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- User profile extension
ALTER TABLE users ADD COLUMN about_me TEXT;

-- Unread tracking
CREATE TABLE read_states (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    last_read_at    TIMESTAMPTZ DEFAULT NOW(),
    mention_count   INT DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);

-- Simple role on server members
ALTER TABLE server_members ADD COLUMN role VARCHAR(16) DEFAULT 'member' NOT NULL;
UPDATE server_members sm SET role = 'owner'
FROM servers s WHERE sm.server_id = s.id AND sm.user_id = s.owner_id;
