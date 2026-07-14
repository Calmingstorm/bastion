import { useState, useEffect, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { apiGetUser, apiKickMember, apiBanMember, apiTimeoutMember } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { useAuthStore } from '../../stores/authStore';
import { openDirectMessage } from '../../stores/dmActions';
import { resolveMediaUrl } from '../../platform';
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

  // Only the LATEST profile fetch owns the card (session + recency), and the
  // displayed profile is keyed to the userId it was fetched for -- a userId change
  // clears the previous profile instead of showing the wrong user while loading.
  const profileSeqRef = useRef(0);
  const shownForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (shownForRef.current !== userId) {
      setUser(null);
      shownForRef.current = userId;
    }
    const generation = captureSessionGeneration();
    const seq = ++profileSeqRef.current;
    apiGetUser(userId)
      .then((u) => {
        if (seq === profileSeqRef.current && isSessionGenerationCurrent(generation)) setUser(u);
      })
      .catch(() => {});
  }, [open, userId]);

  const handleMessage = async () => {
    // Session-guarded create + switch to DM view. openDirectMessage returns undefined
    // if the session changed mid-create, so a DM for the previous account is never
    // selected; only close the card once a current-session DM is actually opened.
    try {
      const dm = await openDirectMessage([userId]);
      if (dm) setOpen(false);
    } catch {
      // Error handling
    }
  };

  const initial = user
    ? (user.displayName || user.username || '?').charAt(0).toUpperCase()
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
                  src={resolveMediaUrl(user.avatarUrl)}
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
                {(joinedAt || user.createdAt) && (
                  <div className="mt-3 border-t border-[var(--border)] pt-3">
                    {user.createdAt && (
                      <>
                        <p className="text-xs font-bold uppercase text-[var(--text-secondary)]">
                          Bastion Member Since
                        </p>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          {formatJoinDate(user.createdAt)}
                        </p>
                      </>
                    )}
                    {joinedAt && (
                      <>
                        <p className={`text-xs font-bold uppercase text-[var(--text-secondary)] ${user.createdAt ? 'mt-2' : ''}`}>
                          Joined Server
                        </p>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          {formatJoinDate(joinedAt)}
                        </p>
                      </>
                    )}
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
                  <ModActions serverId={serverId} userId={userId} onDone={() => setOpen(false)} />
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

const TIMEOUT_OPTIONS = [
  { label: '1 min', seconds: 60 },
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '1 week', seconds: 604800 },
];

function ModActions({ serverId, userId, onDone }: { serverId: string; userId: string; onDone: () => void }) {
  const [showTimeoutPicker, setShowTimeoutPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTimeoutPicker) return;
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowTimeoutPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTimeoutPicker]);

  const handleTimeout = async (seconds: number) => {
    try { await apiTimeoutMember(serverId, userId, seconds); onDone(); } catch { /* ignored */ }
  };

  const btnClass = "flex-1 rounded-[3px] border border-[var(--border)] py-1.5 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10";

  return (
    <div className="mt-2 relative">
      <div className="flex gap-1">
        <button onClick={() => setShowTimeoutPicker(!showTimeoutPicker)} className={btnClass}>
          Timeout
        </button>
        <button onClick={async () => { try { await apiKickMember(serverId, userId); onDone(); } catch { /* ignored */ } }} className={btnClass}>
          Kick
        </button>
        <button onClick={async () => { try { await apiBanMember(serverId, userId); onDone(); } catch { /* ignored */ } }} className={btnClass}>
          Ban
        </button>
      </div>
      {showTimeoutPicker && (
        <div ref={pickerRef} className="absolute bottom-full left-0 mb-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1 shadow-xl z-50">
          {TIMEOUT_OPTIONS.map((opt) => (
            <button
              key={opt.seconds}
              onClick={() => handleTimeout(opt.seconds)}
              className="flex w-full items-center rounded px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
            >
              {opt.label}
            </button>
          ))}
          <div className="my-0.5 h-px bg-[var(--border)]" />
          <button
            onClick={() => handleTimeout(0)}
            className="flex w-full items-center rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--accent)] hover:text-white"
          >
            Remove Timeout
          </button>
        </div>
      )}
    </div>
  );
}
