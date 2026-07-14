DROP TRIGGER IF EXISTS mentions_projection_revision ON mentions;
DROP FUNCTION IF EXISTS bump_read_state_projection_revision();
ALTER TABLE read_states DROP COLUMN IF EXISTS projection_revision;
