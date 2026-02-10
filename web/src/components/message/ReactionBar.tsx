import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useAuthStore } from '../../stores/authStore';
import { apiAddReaction, apiRemoveReaction } from '../../api/client';
import { EmojiPicker } from './EmojiPicker';
import type { Message } from '../../types';

interface ReactionBarProps {
  message: Message;
}

export function ReactionBar({ message }: ReactionBarProps) {
  const currentUser = useAuthStore((s) => s.user);
  const [showPicker, setShowPicker] = useState(false);

  if (!message.reactions || message.reactions.length === 0) return null;

  const handleToggleReaction = async (emoji: string, hasReacted: boolean) => {
    try {
      if (hasReacted) {
        await apiRemoveReaction(message.channelId, message.id, emoji);
      } else {
        await apiAddReaction(message.channelId, message.id, emoji);
      }
    } catch { /* handled */ }
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {message.reactions.map((reaction) => {
        const hasReacted = currentUser ? reaction.users.includes(currentUser.id) : false;
        return (
          <button
            key={reaction.emoji}
            onClick={() => handleToggleReaction(reaction.emoji, hasReacted)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
              hasReacted
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50'
            }`}
          >
            <span className="text-sm">{reaction.emoji}</span>
            <span className="font-medium">{reaction.count}</span>
          </button>
        );
      })}
      <Popover.Root open={showPicker} onOpenChange={setShowPicker}>
        <Popover.Trigger asChild>
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text-secondary)]"
            title="Add reaction"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="top" sideOffset={4} className="z-50">
            <EmojiPicker
              channelId={message.channelId}
              messageId={message.id}
              onClose={() => setShowPicker(false)}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
