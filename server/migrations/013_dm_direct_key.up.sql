-- F23: give direct (1:1) DMs a database-enforced identity so concurrent creates
-- cannot produce duplicate channels.
--
-- Provenance is tracked with a tri-state dm_kind (direct | group | legacy_unknown)
-- rather than inferred from current member count. A group DM can shrink to two
-- members when a participant deletes their account (a soft close keeps the row,
-- so deletion is the only shrink path), which makes a two-member channel
-- indistinguishable from a real direct DM. This migration therefore refuses to
-- classify any legacy DM as direct and keys nothing that already exists; it only
-- records what the database can prove. New direct DMs are keyed by the runtime.
--
-- Existing duplicate direct DMs are intentionally left intact and visible: an
-- automatic merge cannot prove two legacy two-member channels are the same
-- conversation (one could be a shrunk group), and silently splicing unrelated
-- histories is worse than a visible duplicate. Real duplicates are resolved by a
-- separate operator-driven remediation with explicit, human-classified channel
-- ids after a backup. This migration is fully reversible.

ALTER TABLE channels ADD COLUMN dm_user_lo UUID;
ALTER TABLE channels ADD COLUMN dm_user_hi UUID;
ALTER TABLE channels ADD COLUMN dm_kind TEXT;

-- Record provenance for existing DM channels. 3+ members is provably a group;
-- everything else is unknown and must never be auto-adopted as direct.
UPDATE channels c
SET dm_kind = CASE
    WHEN (SELECT count(*) FROM dm_members m WHERE m.channel_id = c.id) >= 3 THEN 'group'
    ELSE 'legacy_unknown'
END
WHERE c.type = 'dm';

-- Equivalence: the key columns are set if and only if the channel is a keyed
-- direct DM. group / legacy_unknown / non-DM (NULL) channels carry no key.
ALTER TABLE channels ADD CONSTRAINT channels_dm_kind_valid CHECK (
    (dm_kind = 'direct'
        AND dm_user_lo IS NOT NULL AND dm_user_hi IS NOT NULL
        AND dm_user_lo < dm_user_hi
        AND type = 'dm' AND server_id IS NULL)
    OR (dm_kind IS DISTINCT FROM 'direct'
        AND dm_user_lo IS NULL AND dm_user_hi IS NULL)
);

-- One keyed direct DM per canonical pair. Only 'direct' rows are covered, so no
-- legacy channel participates.
CREATE UNIQUE INDEX idx_channels_dm_key ON channels (dm_user_lo, dm_user_hi)
    WHERE dm_kind = 'direct';
