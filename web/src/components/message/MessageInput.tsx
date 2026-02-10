import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { wsClient } from '../../api/websocket';
import { apiSendMessageWithFiles, apiGetMembers } from '../../api/client';
import { MentionAutocomplete } from './MentionAutocomplete';
import type { MemberWithUser } from '../../types';

export function MessageInput() {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSentRef = useRef(0);
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const addMessage = useMessageStore((s) => s.addMessage);
  const selectedChannelId = useServerStore((s) => s.selectedChannelId);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const channels = useServerStore((s) => s.channels);
  const selectedDMId = useDMStore((s) => s.selectedDMId);

  // Mention autocomplete state
  const [members, setMembers] = useState<MemberWithUser[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);

  const activeChannelId = selectedChannelId || selectedDMId;
  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  // Fetch members when server changes
  useEffect(() => {
    if (!selectedServerId) {
      setMembers([]);
      return;
    }
    apiGetMembers(selectedServerId).then(setMembers).catch(() => {});
  }, [selectedServerId]);

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
      setShowMentions(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch {
      // Error is handled in the store
    } finally {
      setIsSending(false);
    }
  }, [content, files, activeChannelId, isSending, sendMessage, addMessage]);

  // Detect @mention context from text before cursor
  const checkMentionContext = (text: string, cursorPos: number) => {
    const textBeforeCursor = text.slice(0, cursorPos);
    const match = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/);
    if (match) {
      setShowMentions(true);
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (username: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = content.slice(0, cursorPos);
    const textAfterCursor = content.slice(cursorPos);

    // Find the @ that started this mention
    const match = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/);
    if (!match) return;

    const startPos = cursorPos - match[0].length;
    const newContent = content.slice(0, startPos) + `@${username} ` + textAfterCursor;
    setContent(newContent);
    setShowMentions(false);

    // Restore cursor position after React re-render
    const newCursorPos = startPos + username.length + 2; // @username + space
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = newCursorPos;
      textarea.selectionEnd = newCursorPos;
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => Math.min(9, prev + 1));
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        // Get the currently selected entry
        const lowerQuery = mentionQuery.toLowerCase();
        const entries: string[] = [];
        if ('bastion'.startsWith(lowerQuery)) entries.push('bastion');
        for (const m of members) {
          if (m.username.toLowerCase().startsWith(lowerQuery) || (m.displayName?.toLowerCase().startsWith(lowerQuery))) {
            entries.push(m.username);
          }
          if (entries.length >= 10) break;
        }
        if (entries[mentionIndex]) {
          insertMention(entries[mentionIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }

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
        className={`relative flex items-end rounded-lg bg-[var(--bg-input)] ${isDragOver ? 'ring-2 ring-[var(--accent)]' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Mention autocomplete popup */}
        {showMentions && selectedServerId && (
          <MentionAutocomplete
            members={members}
            query={mentionQuery}
            selectedIndex={mentionIndex}
            onSelect={insertMention}
            onDismiss={() => setShowMentions(false)}
          />
        )}

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
            checkMentionContext(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onClick={(e) => {
            const target = e.target as HTMLTextAreaElement;
            checkMentionContext(target.value, target.selectionStart);
          }}
          placeholder={placeholder}
          rows={1}
          className="max-h-[300px] min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
        />
      </div>
    </div>
  );
}
