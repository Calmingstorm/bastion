import { useMemo } from 'react';
import { useTypingStore } from '../../stores/typingStore';
import { useAuthStore } from '../../stores/authStore';

interface TypingIndicatorProps {
  channelId: string;
  usernames: Record<string, string>; // userId -> displayName
}

export function TypingIndicator({ channelId, usernames }: TypingIndicatorProps) {
  // Select the raw typing record (stable reference) instead of getTypingUsers
  // which returns a new array on every call and breaks useSyncExternalStore
  const channelTyping = useTypingStore((s) => s.typing[channelId]);
  const typingUsers = useMemo(
    () => (channelTyping ? Object.keys(channelTyping) : []),
    [channelTyping]
  );
  const currentUser = useAuthStore((s) => s.user);

  // Filter out the current user
  const others = typingUsers.filter((id) => id !== currentUser?.id);

  if (others.length === 0) return null;

  const names = others
    .map((id) => usernames[id] || 'Someone')
    .slice(0, 3);

  let text: string;
  if (names.length === 1) {
    text = `${names[0]} is typing`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing`;
  } else {
    text = 'Several people are typing';
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1 text-xs text-[var(--text-muted)]">
      <span className="flex gap-0.5">
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-muted)] [animation-delay:-0.3s]" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-muted)] [animation-delay:-0.15s]" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-muted)]" />
      </span>
      <span>{text}...</span>
    </div>
  );
}
