import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';

export function MessageInput() {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage } = useMessageStore();
  const { selectedChannelId, channels } = useServerStore();

  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || !selectedChannelId || isSending) return;

    setIsSending(true);
    try {
      await sendMessage(selectedChannelId, trimmed);
      setContent('');
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch {
      // Error is handled in the store
    } finally {
      setIsSending(false);
    }
  }, [content, selectedChannelId, isSending, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const maxHeight = 300;
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    }
  };

  if (!selectedChannelId) return null;

  return (
    <div className="shrink-0 px-4 pb-6">
      <div className="flex items-end rounded-lg bg-[var(--bg-input)]">
        {/* Attachment button placeholder */}
        <button
          className="mb-2.5 ml-3 shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          title="Attach file"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          placeholder={`Message #${selectedChannel?.name || 'channel'}`}
          rows={1}
          disabled={isSending}
          className="max-h-[300px] min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
        />
      </div>
    </div>
  );
}
