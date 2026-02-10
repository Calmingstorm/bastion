import { useState, useRef, useEffect } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { Server, Channel } from '../../types';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useAuthStore } from '../../stores/authStore';

interface ServerIconProps {
  server: Server;
  isSelected: boolean;
  onClick: () => void;
}

const EMPTY_CHANNELS: Channel[] = [];

const COLORS = [
  '#0ea5e9', // sky
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#22c55e', // green
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#a855f7', // purple
  '#6366f1', // indigo
];

function getColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function ServerIcon({ server, isSelected, onClick }: ServerIconProps) {
  const initial = server.name.charAt(0).toUpperCase();
  const bgColor = getColorForId(server.id);
  const channels = useServerStore((s) =>
    s.selectedServerId === server.id ? s.channels : EMPTY_CHANNELS
  );
  const unreadChannels = useUnreadStore((s) => s.unreadChannels);
  const readStates = useUnreadStore((s) => s.readStates);
  const currentUser = useAuthStore((s) => s.user);
  const leaveServer = useServerStore((s) => s.leaveServer);

  const isOwner = currentUser?.id === server.ownerId;

  // Check if any channel in this server has unreads/mentions
  const hasUnread = channels.some((c) => unreadChannels.has(c.id));
  const totalMentions = channels.reduce(
    (sum, c) => sum + (readStates[c.id]?.mentionCount || 0),
    0
  );

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setShowLeaveConfirm(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxMenu]);

  const handleLeave = async () => {
    try {
      await leaveServer(server.id);
    } catch { /* handled */ }
    setCtxMenu(null);
    setShowLeaveConfirm(false);
  };

  const tooltipText = server.memberCount
    ? `${server.name} — ${server.memberCount} member${server.memberCount !== 1 ? 's' : ''}`
    : server.name;

  return (
    <>
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div className="group relative flex items-center justify-center" onContextMenu={handleContextMenu}>
              {/* Selection / unread indicator pill */}
              <div
                className={`absolute left-0 w-1 rounded-r-full bg-white transition-all duration-200 ${
                  isSelected
                    ? 'h-10'
                    : hasUnread
                      ? 'h-2'
                      : 'h-0 group-hover:h-5'
                }`}
              />

              <button
                onClick={onClick}
                className={`relative flex h-12 w-12 items-center justify-center rounded-xl text-lg font-semibold text-white transition-all duration-200 ${
                  isSelected ? 'ring-2 ring-white/20' : ''
                }`}
                style={{
                  backgroundColor: server.iconUrl ? 'transparent' : bgColor,
                }}
              >
                {server.iconUrl ? (
                  <img
                    src={server.iconUrl}
                    alt={server.name}
                    className="h-12 w-12 rounded-xl object-cover"
                  />
                ) : (
                  initial
                )}

                {/* Mention count badge */}
                {totalMentions > 0 && (
                  <span className="absolute -bottom-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[11px] font-bold text-white ring-2 ring-[var(--bg-tertiary)]">
                    {totalMentions > 99 ? '99+' : totalMentions}
                  </span>
                )}
              </button>
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="right"
              sideOffset={8}
              className="z-50 rounded-md bg-[var(--bg-tertiary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] shadow-lg"
            >
              {tooltipText}
              <Tooltip.Arrow className="fill-[var(--bg-tertiary)]" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fixed z-[60] min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] p-1 shadow-xl"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {!isOwner && !showLeaveConfirm && (
            <button
              onClick={() => setShowLeaveConfirm(true)}
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10"
            >
              Leave Server
            </button>
          )}
          {!isOwner && showLeaveConfirm && (
            <div className="space-y-1 p-1">
              <p className="text-xs text-[var(--text-muted)]">Leave <strong>{server.name}</strong>?</p>
              <div className="flex gap-1">
                <button onClick={handleLeave}
                  className="rounded bg-[var(--danger)] px-2 py-1 text-xs font-medium text-white hover:opacity-90">Leave</button>
                <button onClick={() => { setShowLeaveConfirm(false); setCtxMenu(null); }}
                  className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              </div>
            </div>
          )}
          {isOwner && (
            <p className="px-2 py-1.5 text-xs text-[var(--text-muted)]">
              You own this server
            </p>
          )}
        </div>
      )}
    </>
  );
}
