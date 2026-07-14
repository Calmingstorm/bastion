-- Mention badges become a PROJECTION of (mentions, read watermark), not mutable
-- running state. read_states.mention_count was a single integer that both the
-- ack (zeroed it) and the mention path (incremented it) rewrote, with no way to
-- know WHICH messages it counted: acking message seq=1 wiped a mention belonging
-- to seq=2, and a mention increment racing an ack wedged a phantom badge. A
-- per-mention row carrying the message's seq removes the ambiguity -- the badge
-- is COUNT(mentions with seq > last_read_seq), computed at read time.

CREATE TABLE mentions (
    user_id    UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id UUID   NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id UUID   NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    seq        BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, message_id)
);

-- The hot query is "count of this user's mentions in this channel above their
-- read watermark", so index by (user_id, channel_id, seq).
CREATE INDEX idx_mentions_user_channel_seq ON mentions (user_id, channel_id, seq);

-- The stored counter is retired: historical mention counts cannot be
-- reconstructed into per-message rows (the messages that caused them are not
-- recorded), so pre-migration badges reset to reflect only mentions going
-- forward -- an accepted one-time reset in exchange for a count that is
-- thereafter always correct.
ALTER TABLE read_states DROP COLUMN mention_count;
