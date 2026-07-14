ALTER TABLE read_states ADD COLUMN mention_count INT DEFAULT 0;
DROP TABLE IF EXISTS mentions;
