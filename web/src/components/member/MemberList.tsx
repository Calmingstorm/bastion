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

  // Group by role
  const owners = members.filter((m) => m.role === 'owner');
  const memberList = members.filter((m) => m.role === 'member');

  // Sort: online first within each group
  const sortByPresence = (a: MemberWithUser, b: MemberWithUser) => {
    const aOnline = (presences[a.userId] || a.status) !== 'offline';
    const bOnline = (presences[b.userId] || b.status) !== 'offline';
    if (aOnline && !bOnline) return -1;
    if (!aOnline && bOnline) return 1;
    return 0;
  };

  owners.sort(sortByPresence);
  memberList.sort(sortByPresence);

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
            {memberList.length > 0 && (
              <MemberGroup title={`Members — ${memberList.length}`} members={memberList} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MemberGroup({ title, members }: { title: string; members: MemberWithUser[] }) {
  return (
    <div className="mb-4">
      <span className="mb-1 block px-1 text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
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
        <span className="truncate text-sm font-medium text-[var(--text-secondary)]">
          {displayName}
        </span>
      </button>
    </UserProfileCard>
  );
}
