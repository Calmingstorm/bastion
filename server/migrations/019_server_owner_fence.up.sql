-- Future-proof the server-event fence. authorizedMemberIDs reads servers.owner_id,
-- but migration 017 fenced the servers table on DELETE only. An ownership transfer
-- (UPDATE servers SET owner_id) would change channel-visibility authorization
-- without taking the exclusive per-server lock, reopening the create-vs-authz race
-- the fence closes. No endpoint updates owner_id today, so this trigger fires
-- NEVER until such an endpoint is added -- at which point the race is already
-- closed by construction. The lock function already resolves NEW.id on UPDATE.
DROP TRIGGER IF EXISTS fence_server_delete_events ON servers;

CREATE TRIGGER fence_server_owner_events
    BEFORE UPDATE OF owner_id OR DELETE ON servers
    FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();
