import { useState, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { apiGetUser, apiCreateDM, apiKickMember, apiBanMember, apiTimeoutMember } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { PresenceDot } from './PresenceDot';
import type { User, RoleInfo } from '../../types';

interface UserProfileCardProps {
  userId: string;
  roles?: RoleInfo[];
  joinedAt?: string;
  serverId?: string;
  canModerate?: boolean;
  isOwner?: boolean;
  children: React.ReactNode;
}

export function UserProfileCard({ userId, roles, joinedAt, serverId, canModerate, isOwner, children }: UserProfileCardProps) {
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const currentUser = useAuthStore((s) => s.user);
  const { selectDM } = useDMStore();

  useEffect(() => {
    if (open && !user) {
      apiGetUser(userId).then(setUser).catch(() => {});
    }
  }, [open, userId, user]);

  const handleMessage = async () => {
    try {
      const dm = await apiCreateDM([userId]);
      // Switch to DM view
      useServerStore.setState({ selectedServerId: null, selectedChannelId: null });
      selectDM(dm.id);
      setOpen(false);
    } catch {
      // Error handling
    }
  };

  const initial = user
    ? (user.displayName || user.username).charAt(0).toUpperCase()
    : '?';

  const formatJoinDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          sideOffset={8}
          className="z-50 w-72 rounded-lg bg-[var(--bg-primary)] shadow-xl border border-[var(--border)]"
        >
          {/* Banner */}
          <div className="h-16 rounded-t-lg bg-[var(--accent)]" />

          {/* Avatar */}
          <div className="relative px-4">
            <div className="absolute -top-8">
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.displayName || user.username}
                  className="h-16 w-16 rounded-full border-4 border-[var(--bg-primary)] object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-[var(--bg-primary)] bg-[var(--accent)] text-xl font-bold text-white">
                  {initial}
                </div>
              )}
              <PresenceDot userId={userId} className="absolute bottom-0 right-0" />
            </div>
          </div>

          {/* Info */}
          <div className="px-4 pt-10 pb-4">
            {user ? (
              <>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">
                  {user.displayName || user.username}
                </h3>
                <p className="text-sm text-[var(--text-muted)]">@{user.username}</p>
                {user.aboutMe && (
                  <div className="mt-3 border-t border-[var(--border)] pt-3">
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">
                      About Me
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {user.aboutMe}
                    </p>
                  </div>
                )}
                {roles && roles.length > 0 && (
                  <div className="mt-3 border-t border-[var(--border)] pt-3">
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">
                      Roles
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {roles.map((role) => (
                        <span
                          key={role.id}
                          className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-xs font-medium text-[var(--text-secondary)]"
                        >
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: role.color || 'var(--text-muted)' }} />
                          {role.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {joinedAt && (
                  <div className="mt-3 border-t border-[var(--border)] pt-3">
                    <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">
                      Member Since
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {formatJoinDate(joinedAt)}
                    </p>
                  </div>
                )}
                {currentUser?.id !== userId && (
                  <button
                    onClick={handleMessage}
                    className="mt-3 w-full rounded-[3px] bg-[var(--accent)] py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]"
                  >
                    Message
                  </button>
                )}
                {canModerate && !isOwner && currentUser?.id !== userId && serverId && (
                  <div className="mt-2 flex gap-1">
                    <button
                      onClick={async () => { try { await apiTimeoutMember(serverId, userId, 300); setOpen(false); } catch {} }}
                      className="flex-1 rounded-[3px] border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10"
                    >
                      Timeout
                    </button>
                    <button
                      onClick={async () => { try { await apiKickMember(serverId, userId); setOpen(false); } catch {} }}
                      className="flex-1 rounded-[3px] border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10"
                    >
                      Kick
                    </button>
                    <button
                      onClick={async () => { try { await apiBanMember(serverId, userId); setOpen(false); } catch {} }}
                      className="flex-1 rounded-[3px] border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10"
                    >
                      Ban
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center py-4">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
