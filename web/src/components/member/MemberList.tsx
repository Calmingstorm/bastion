import { useEffect, useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { apiGetMembers } from '../../api/client';
import { UserProfileCard } from '../user/UserProfileCard';
import { PresenceDot } from '../user/PresenceDot';
import type { MemberWithUser } from '../../types';

export function MemberList() {
  const { selectedServerId } = useServerStore();
  const [members, setMembers] = useState<MemberWithUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const presences = usePresenceStore((s) => s.presences);

  useEffect(() => {
    if (!selectedServerId) return;
    setIsLoading(true);
    apiGetMembers(selectedServerId)
      .then((m) => {
        setMembers(m);
        // Seed presence store
        const { setPresence } = usePresenceStore.getState();
        m.forEach((member) => setPresence(member.userId, member.status));
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [selectedServerId]);

  if (!selectedServerId) return null;

  // Group: Owner first, then by highest role, then members with no custom roles
  const servers = useServerStore.getState().servers;
  const server = servers.find((s) => s.id === selectedServerId);

  const owners = members.filter((m) => server && m.userId === server.ownerId);
  const nonOwners = members.filter((m) => !(server && m.userId === server.ownerId));

  // Collect unique roles across non-owner members
  const roleGroups = new Map<string, { name: string; color?: string; position: number; members: MemberWithUser[] }>();
  const noRoleMembers: MemberWithUser[] = [];

  for (const member of nonOwners) {
    if (member.roles && member.roles.length > 0) {
      // Assign to highest role
      const highestRole = [...member.roles].sort((a, b) => b.position - a.position)[0];
      const existing = roleGroups.get(highestRole.id);
      if (existing) {
        existing.members.push(member);
      } else {
        roleGroups.set(highestRole.id, {
          name: highestRole.name,
          color: highestRole.color,
          position: highestRole.position,
          members: [member],
        });
      }
    } else {
      noRoleMembers.push(member);
    }
  }

  // Sort role groups by position (highest first)
  const sortedRoleGroups = [...roleGroups.values()].sort((a, b) => b.position - a.position);

  // Sort: online first within each group
  const sortByPresence = (a: MemberWithUser, b: MemberWithUser) => {
    const aOnline = (presences[a.userId] || a.status) !== 'offline';
    const bOnline = (presences[b.userId] || b.status) !== 'offline';
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return 0;
  };

  owners.sort(sortByPresence);
  sortedRoleGroups.forEach((g) => g.members.sort(sortByPresence));
  noRoleMembers.sort(sortByPresence);

  const onlineCount = members.filter(
    (m) => (presences[m.userId] || m.status) !== 'offline'
  ).length;

  return (
    <div className="flex h-full w-60 flex-col bg-[var(--bg-secondary)]">
      <div className="flex h-12 items-center border-b border-[var(--border)] px-4">
        <span className="text-sm font-semibold text-[var(--text-muted)]">
          Members — {onlineCount} Online
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
          </div>
        ) : (
          <>
            {owners.length > 0 && (
              <MemberGroup title={`Owner — ${owners.length}`} members={owners} />
            )}
            {sortedRoleGroups.map((group) => (
              <MemberGroup
                key={group.name}
                title={`${group.name} — ${group.members.length}`}
                members={group.members}
                color={group.color}
              />
            ))}
            {noRoleMembers.length > 0 && (
              <MemberGroup title={`Members — ${noRoleMembers.length}`} members={noRoleMembers} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MemberGroup({ title, members, color }: { title: string; members: MemberWithUser[]; color?: string }) {
  return (
    <div className="mb-4">
      <span
        className="mb-1 block px-1 text-[11px] font-bold uppercase tracking-wide"
        style={{ color: color || 'var(--text-muted)' }}
      >
        {title}
      </span>
      {members.map((member) => (
        <MemberItem key={member.userId} member={member} />
      ))}
    </div>
  );
}

function MemberItem({ member }: { member: MemberWithUser }) {
  const status = usePresenceStore((s) => s.presences[member.userId] || member.status);
  const isOffline = status === 'offline';
  const displayName = member.nickname || member.displayName || member.username;
  const initial = displayName.charAt(0).toUpperCase();

  // Show highest role color on name
  const highestRole = member.roles && member.roles.length > 0
    ? [...member.roles].sort((a, b) => b.position - a.position)[0]
    : null;

  return (
    <UserProfileCard userId={member.userId}>
      <button
        className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-input)]/50 ${
          isOffline ? 'opacity-40' : ''
        }`}
      >
        <div className="relative shrink-0">
          {member.avatarUrl ? (
            <img
              src={member.avatarUrl}
              alt={displayName}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
              {initial}
            </div>
          )}
          <PresenceDot
            userId={member.userId}
            className="absolute -bottom-0.5 -right-0.5"
          />
        </div>
        <span
          className="truncate text-sm font-medium"
          style={{ color: highestRole?.color || 'var(--text-secondary)' }}
        >
          {displayName}
        </span>
      </button>
    </UserProfileCard>
  );
}
