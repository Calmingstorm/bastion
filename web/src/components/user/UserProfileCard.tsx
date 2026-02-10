import { useState, useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { apiGetUser, apiCreateDM } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { PresenceDot } from './PresenceDot';
import type { User } from '../../types';

interface UserProfileCardProps {
  userId: string;
  children: React.ReactNode;
}

export function UserProfileCard({ userId, children }: UserProfileCardProps) {
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
                {currentUser?.id !== userId && (
                  <button
                    onClick={handleMessage}
                    className="mt-3 w-full rounded-[3px] bg-[var(--accent)] py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]"
                  >
                    Message
                  </button>
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
