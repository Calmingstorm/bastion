import * as Tooltip from '@radix-ui/react-tooltip';
import type { Server, Channel } from '../../types';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';

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

  // Check if any channel in this server has unreads/mentions
  const hasUnread = channels.some((c) => unreadChannels.has(c.id));
  const totalMentions = channels.reduce(
    (sum, c) => sum + (readStates[c.id]?.mentionCount || 0),
    0
  );

  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="group relative flex items-center justify-center">
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
            {server.name}
            <Tooltip.Arrow className="fill-[var(--bg-tertiary)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
