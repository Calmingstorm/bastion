import type { Message } from '../../types';

interface MessageItemProps {
  message: Message;
  isCompact: boolean;
}

const AVATAR_COLORS = [
  '#5865f2',
  '#57f287',
  '#fee75c',
  '#eb459e',
  '#ed4245',
  '#3ba55d',
  '#e67e22',
  '#9b59b6',
  '#1abc9c',
  '#e91e63',
];

function getAvatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFullTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const isToday = date.toDateString() === today.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;

  return `${date.toLocaleDateString([], {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  })} ${time}`;
}

export function MessageItem({ message, isCompact }: MessageItemProps) {
  const { author, content, createdAt, editedAt } = message;
  const displayName = author.displayName || author.username;
  const initial = displayName.charAt(0).toUpperCase();
  const avatarColor = getAvatarColor(author.id);

  if (isCompact) {
    return (
      <div className="group flex items-start gap-4 py-0.5 pr-12 pl-[72px] hover:bg-[var(--bg-secondary)]/30">
        <span className="invisible mt-0.5 text-[11px] text-[var(--text-muted)] group-hover:visible shrink-0 w-10 text-right">
          {formatTime(createdAt)}
        </span>
        <div className="min-w-0 flex-1 -ml-14">
          <p className="whitespace-pre-wrap break-words text-[15px] text-[var(--text-secondary)]">
            {content}
            {editedAt && (
              <span className="ml-1 text-[10px] text-[var(--text-muted)]">
                (edited)
              </span>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex gap-4 py-1 pr-12 pl-4 mt-[17px] hover:bg-[var(--bg-secondary)]/30">
      {/* Avatar */}
      {author.avatarUrl ? (
        <img
          src={author.avatarUrl}
          alt={displayName}
          className="mt-0.5 h-10 w-10 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: avatarColor }}
        >
          {initial}
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-[var(--text-primary)] hover:underline cursor-pointer">
            {displayName}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {formatFullTimestamp(createdAt)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-[15px] text-[var(--text-secondary)]">
          {content}
          {editedAt && (
            <span className="ml-1 text-[10px] text-[var(--text-muted)]">
              (edited)
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

export function DateSeparator({ date }: { date: string }) {
  const d = new Date(date);
  const formatted = d.toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="my-2 flex items-center gap-2 px-4">
      <div className="flex-1 border-t border-[var(--border)]" />
      <span className="text-xs font-semibold text-[var(--text-muted)]">
        {formatted}
      </span>
      <div className="flex-1 border-t border-[var(--border)]" />
    </div>
  );
}
