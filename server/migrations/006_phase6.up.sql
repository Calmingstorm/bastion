-- Phase 6: Core Polish & Completeness

-- Message pinning
CREATE TABLE message_pins (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(channel_id, message_id)
);
CREATE INDEX idx_message_pins_channel ON message_pins(channel_id, created_at DESC);
