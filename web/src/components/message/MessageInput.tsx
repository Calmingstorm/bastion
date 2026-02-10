import { useState, useRef, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { wsClient } from '../../api/websocket';
import { apiSendMessageWithFiles } from '../../api/client';

export function MessageInput() {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSentRef = useRef(0);
  const { sendMessage, addMessage } = useMessageStore();
  const { selectedChannelId, channels } = useServerStore();
  const { selectedDMId } = useDMStore();

  const activeChannelId = selectedChannelId || selectedDMId;
  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  const sendTyping = useCallback(() => {
    if (!activeChannelId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current > 5000) {
      lastTypingSentRef.current = now;
      wsClient.send('TYPING_START', { channelId: activeChannelId });
    }
  }, [activeChannelId]);

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if ((!trimmed && files.length === 0) || !activeChannelId || isSending) return;

    setIsSending(true);
    try {
      if (files.length > 0) {
        const msg = await apiSendMessageWithFiles(activeChannelId, trimmed, files);
        addMessage(activeChannelId, msg);
      } else {
        await sendMessage(activeChannelId, trimmed);
      }
      setContent('');
      setFiles([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch {
      // Error is handled in the store
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [content, files, activeChannelId, isSending, sendMessage, addMessage]);

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
    sendTyping();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      setFiles((prev) => [...prev, ...droppedFiles].slice(0, 10));
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      setFiles((prev) => [...prev, ...pastedFiles].slice(0, 10));
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  if (!activeChannelId) return null;

  const placeholder = selectedChannel
    ? `Message #${selectedChannel.name}`
    : 'Message';

  return (
    <div className="shrink-0 px-4 pb-6">
      {/* File preview chips */}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
            >
              <span className="max-w-[150px] truncate">{file.name}</span>
              <button
                onClick={() => removeFile(i)}
                className="text-[var(--text-muted)] hover:text-[var(--danger)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={`flex items-end rounded-lg bg-[var(--bg-input)] ${isDragOver ? 'ring-2 ring-[var(--accent)]' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const selected = Array.from(e.target.files || []);
            setFiles((prev) => [...prev, ...selected].slice(0, 10));
            e.target.value = '';
          }}
        />

        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          disabled={isSending}
          className="max-h-[300px] min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
        />
      </div>
    </div>
  );
}
