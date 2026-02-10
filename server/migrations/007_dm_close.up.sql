-- Allow users to close/hide DMs without deleting history
ALTER TABLE dm_members ADD COLUMN closed_at TIMESTAMPTZ;
