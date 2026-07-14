DROP TRIGGER IF EXISTS fence_server_delete_events ON servers;
DROP TRIGGER IF EXISTS fence_channel_delete_events ON channels;
DROP TRIGGER IF EXISTS fence_roles_events ON roles;
DROP TRIGGER IF EXISTS fence_member_roles_events ON member_roles;
DROP TRIGGER IF EXISTS fence_server_members_events ON server_members;
DROP FUNCTION IF EXISTS lock_bastion_server_events();
