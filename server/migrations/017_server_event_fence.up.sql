-- Serialize channel-create authorization/existence reads with commits that can
-- change channel visibility or delete the channel/server. The create path holds
-- the matching shared session advisory lock through live-hub reconciliation and
-- synchronous dispatch; these triggers take the exclusive transaction lock.
CREATE OR REPLACE FUNCTION lock_bastion_server_events()
RETURNS TRIGGER AS $$
DECLARE
    sid UUID;
BEGIN
    IF TG_TABLE_NAME = 'servers' THEN
        IF TG_OP = 'DELETE' THEN sid := OLD.id; ELSE sid := NEW.id; END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN sid := OLD.server_id; ELSE sid := NEW.server_id; END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(
        hashtextextended('bastion-server-events:' || sid::text, 0)
    );
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fence_server_members_events
BEFORE INSERT OR UPDATE OR DELETE ON server_members
FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();

CREATE TRIGGER fence_member_roles_events
BEFORE INSERT OR UPDATE OR DELETE ON member_roles
FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();

CREATE TRIGGER fence_roles_events
BEFORE INSERT OR UPDATE OR DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();

CREATE TRIGGER fence_channel_delete_events
BEFORE DELETE ON channels
FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();

CREATE TRIGGER fence_server_delete_events
BEFORE DELETE ON servers
FOR EACH ROW EXECUTE FUNCTION lock_bastion_server_events();
