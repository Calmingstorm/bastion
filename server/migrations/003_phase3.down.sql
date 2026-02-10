-- Rollback Phase 3

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS server_bans;
DROP TABLE IF EXISTS channel_permission_overrides;
DROP TABLE IF EXISTS member_roles;
ALTER TABLE channels DROP COLUMN IF EXISTS category_id;
DROP TABLE IF EXISTS channel_categories;
DROP TABLE IF EXISTS roles;
ALTER TABLE servers DROP COLUMN IF EXISTS description;
ALTER TABLE server_members DROP COLUMN IF EXISTS timed_out_until;
