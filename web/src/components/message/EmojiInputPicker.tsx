import { useState, useRef, useEffect } from 'react';

const COMMON_EMOJI = [
  '👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🔥',
  '👀', '🎉', '✅', '❌', '💯', '🙏', '🤔', '👏',
  '💀', '🫡', '😭', '🥳', '✨', '🚀', '💪', '🤝',
  '😎', '🤣', '😍', '🫠', '💜', '🧡', '💚', '💙',
  '⭐', '🏆', '🎯', '🪄', '🐛', '☕', '🍕', '🎵',
];

interface EmojiInputPickerProps {
  onSelect: (emoji: string) => void;
}

export function EmojiInputPicker({ onSelect }: EmojiInputPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        title="Emoji"
        type="button"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[280px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 shadow-xl">
          <div className="grid grid-cols-8 gap-0.5">
            {COMMON_EMOJI.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  onSelect(emoji);
                  setOpen(false);
                }}
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded text-lg transition-colors hover:bg-[var(--bg-input)]"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
