DROP TRIGGER IF EXISTS fence_server_owner_events ON servers;

CREATE TRIGGER fence_server_delete_events
    BEFORE DELETE ON servers
    FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();
