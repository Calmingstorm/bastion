import type { Channel } from '../../types';
import { useUnreadStore } from '../../stores/unreadStore';

interface ChannelItemProps {
  channel: Channel;
  isSelected: boolean;
  onClick: () => void;
}

export function ChannelItem({ channel, isSelected, onClick }: ChannelItemProps) {
  const hasUnread = useUnreadStore((s) => s.isUnread(channel.id));
  const mentionCount = useUnreadStore((s) => s.getMentionCount(channel.id));

  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-1.5 rounded-[4px] px-2 py-1.5 text-left transition-colors ${
        isSelected
          ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
          : hasUnread
            ? 'text-[var(--text-primary)] hover:bg-[var(--bg-input)]/50'
            : 'text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]'
      }`}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 opacity-60"
      >
        <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
      </svg>
      <span
        className={`min-w-0 flex-1 truncate text-sm ${
          hasUnread && !isSelected ? 'font-bold' : 'font-medium'
        }`}
      >
        {channel.name}
      </span>
      {mentionCount > 0 && (
        <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-bold text-white">
          {mentionCount}
        </span>
      )}
    </button>
  );
}
