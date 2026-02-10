import { apiAddReaction } from '../../api/client';

const COMMON_EMOJI = [
  '👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🔥',
  '👀', '🎉', '✅', '❌', '💯', '🙏', '🤔', '👏',
  '💀', '🫡', '😭', '🥳', '✨', '🚀', '💪', '🤝',
  '😎', '🤣', '😍', '🫠', '💜', '🧡', '💚', '💙',
  '⭐', '🏆', '🎯', '🪄', '🐛', '☕', '🍕', '🎵',
];

interface EmojiPickerProps {
  channelId: string;
  messageId: string;
  onClose: () => void;
}

export function EmojiPicker({ channelId, messageId, onClose }: EmojiPickerProps) {
  const handleSelect = async (emoji: string) => {
    try {
      await apiAddReaction(channelId, messageId, emoji);
    } catch { /* handled */ }
    onClose();
  };

  return (
    <div className="w-[280px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 shadow-xl">
      <div className="grid grid-cols-8 gap-0.5">
        {COMMON_EMOJI.map((emoji) => (
          <button
            key={emoji}
            onClick={() => handleSelect(emoji)}
            className="flex h-8 w-8 items-center justify-center rounded text-lg transition-colors hover:bg-[var(--bg-input)]"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
