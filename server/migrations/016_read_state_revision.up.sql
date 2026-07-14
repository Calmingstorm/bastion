-- Read-state projections with the same last_read_seq are not necessarily the
-- same snapshot: a mention can commit above that watermark between two reads.
-- This revision is advanced under the read_states row lock by every change to
-- either side of the projection (ack watermark or committed mention), giving
-- clients a database-ordered tie-breaker for out-of-order responses.
ALTER TABLE read_states
    ADD COLUMN projection_revision BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_read_state_projection_revision()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE read_states
       SET projection_revision = projection_revision + 1
     WHERE user_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END
       AND channel_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.channel_id ELSE NEW.channel_id END;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mentions_projection_revision
AFTER INSERT OR DELETE ON mentions
FOR EACH ROW EXECUTE FUNCTION bump_read_state_projection_revision();
