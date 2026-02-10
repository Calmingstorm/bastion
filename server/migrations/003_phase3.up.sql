-- Phase 3: Permissions & Server Management

-- Roles (replaces the simple server_members.role column)
CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    color       VARCHAR(7),            -- hex color e.g. "#0ea5e9"
    position    INT NOT NULL DEFAULT 0, -- higher = more authority
    permissions BIGINT NOT NULL DEFAULT 0,
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_roles_server ON roles(server_id);

-- Junction: member <-> roles (many-to-many)
CREATE TABLE member_roles (
    server_id UUID NOT NULL,
    user_id   UUID NOT NULL,
    role_id   UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_member_roles_role ON member_roles(role_id);

-- Channel categories
CREATE TABLE channel_categories (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name      VARCHAR(100) NOT NULL,
    position  INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_categories_server ON channel_categories(server_id);

-- Channel permission overrides (per-role or per-member)
CREATE TABLE channel_permission_overrides (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('role', 'member')),
    target_id   UUID NOT NULL,
    allow       BIGINT NOT NULL DEFAULT 0,
    deny        BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_overrides_channel ON channel_permission_overrides(channel_id);

-- Server bans
CREATE TABLE server_bans (
    server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason    TEXT,
    banned_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (server_id, user_id)
);

-- Audit log
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    actor_id    UUID NOT NULL REFERENCES users(id),
    action_type VARCHAR(50) NOT NULL,
    target_type VARCHAR(50),
    target_id   UUID,
    changes     JSONB,
    reason      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_log_server ON audit_log(server_id, created_at DESC);

-- Add description to servers
ALTER TABLE servers ADD COLUMN description TEXT;

-- Add category_id to channels
ALTER TABLE channels ADD COLUMN category_id UUID REFERENCES channel_categories(id) ON DELETE SET NULL;

-- Add timeout to server_members
ALTER TABLE server_members ADD COLUMN timed_out_until TIMESTAMPTZ;

-- Create default @bastion role for all existing servers
INSERT INTO roles (server_id, name, color, position, permissions, is_default)
SELECT id, '@bastion', NULL, 0,
       -- Default permissions: VIEW_CHANNEL | SEND_MESSAGES | CREATE_INVITES | ATTACH_FILES
       -- Bits: 0x1 | 0x2 | 0x40 | 0x200 = 0x243 = 579
       579,
       TRUE
FROM servers;

-- Assign all existing members to the default @bastion role
INSERT INTO member_roles (server_id, user_id, role_id)
SELECT sm.server_id, sm.user_id, r.id
FROM server_members sm
INNER JOIN roles r ON r.server_id = sm.server_id AND r.is_default = TRUE;
