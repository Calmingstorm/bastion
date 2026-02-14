import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent, type DragEvent, type ClipboardEvent } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { wsClient } from '../../api/websocket';
import { apiSendMessageWithFiles, apiGetMembers, apiExecuteInteraction } from '../../api/client';
import { MentionAutocomplete } from './MentionAutocomplete';
import { SlashCommandPicker } from './SlashCommandPicker';
import { EmojiInputPicker } from './EmojiInputPicker';
import { GifPicker } from './GifPicker';
import { useFeatureStore } from '../../stores/featureStore';
import { useCommandStore } from '../../stores/commandStore';
import type { MemberWithUser, ApplicationCommand } from '../../types';
import { eventBus } from '../../utils/eventBus';

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
  const replyingTo = useMessageStore((s) => s.replyingTo);
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo);
  const selectedChannelId = useServerStore((s) => s.selectedChannelId);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const channels = useServerStore((s) => s.channels);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const dmChannels = useDMStore((s) => s.dmChannels);
  const gifEnabled = useFeatureStore((s) => s.features.gifSearch);

  // Mention autocomplete state
  const [members, setMembers] = useState<MemberWithUser[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);

  // Slash command picker state
  const commands = useCommandStore((s) => s.commands);
  const fetchCommands = useCommandStore((s) => s.fetchCommands);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);

  const activeChannelId = selectedChannelId || selectedDMId;
  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  // Generate preview URLs for image files
  const previewUrls = useMemo(() => files.map((f) =>
    f.type.startsWith('image/') ? URL.createObjectURL(f) : ''
  ), [files]);

  // Revoke object URLs on cleanup
  useEffect(() => {
    return () => {
      previewUrls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
    };
  }, [previewUrls]);

  // Fetch members when server changes
  useEffect(() => {
    if (!selectedServerId) {
      setMembers([]);
      return;
    }
    apiGetMembers(selectedServerId).then(setMembers).catch(() => {});
  }, [selectedServerId]);

  // Fetch slash commands when server changes
  useEffect(() => {
    if (!selectedServerId) {
      useCommandStore.getState().clear();
      return;
    }
    fetchCommands(selectedServerId);
  }, [selectedServerId, fetchCommands]);

  // Refresh members when a new member joins
  useEffect(() => {
    if (!selectedServerId) return;
    const handler = () => {
      apiGetMembers(selectedServerId).then(setMembers).catch(() => {});
    };
    eventBus.on('bastion:member-join', handler);
    return () => eventBus.off('bastion:member-join', handler);
  }, [selectedServerId]);

  // Clear reply when switching channels
  useEffect(() => {
    setReplyingTo(null);
  }, [activeChannelId, setReplyingTo]);

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
        eventBus.emit('bastion:message-sent');
      } else {
        await sendMessage(activeChannelId, trimmed, replyingTo?.id);
      }
      setContent('');
      setFiles([]);
      setShowMentions(false);
      setReplyingTo(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch {
      // Error is handled in the store
    } finally {
      setIsSending(false);
    }
  }, [content, files, activeChannelId, isSending, sendMessage, addMessage, replyingTo, setReplyingTo]);

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

  // Detect /slash command context
  const checkSlashContext = (text: string) => {
    if (text.startsWith('/') && !text.includes(' ') && commands.length > 0) {
      const query = text.slice(1);
      const hasMatches = commands.some((cmd) => cmd.type === 1 && cmd.name.startsWith(query.toLowerCase()));
      setShowSlashPicker(hasMatches);
      setSlashQuery(query);
      setSlashIndex(0);
    } else {
      setShowSlashPicker(false);
    }
  };

  const handleSlashSelect = async (cmd: ApplicationCommand) => {
    if (!activeChannelId || !selectedServerId) return;

    setShowSlashPicker(false);
    setContent('');

    if (cmd.options && cmd.options.length > 0) {
      // For commands with options, we'd need a more complex flow.
      // For now, execute with no options and let the bot handle defaults.
      try {
        await apiExecuteInteraction(selectedServerId, {
          commandId: cmd.id,
          channelId: activeChannelId,
        });
      } catch { /* handled */ }
    } else {
      try {
        await apiExecuteInteraction(selectedServerId, {
          commandId: cmd.id,
          channelId: activeChannelId,
        });
      } catch { /* handled */ }
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

  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    const newContent = content.slice(0, cursorPos) + emoji + content.slice(cursorPos);
    setContent(newContent);
    const newCursorPos = cursorPos + emoji.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = newCursorPos;
      textarea.selectionEnd = newCursorPos;
    });
  };

  const handleGifSelect = useCallback(async (url: string) => {
    if (!activeChannelId || isSending) return;
    setIsSending(true);
    try {
      await sendMessage(activeChannelId, url);
    } catch { /* handled in store */ }
    finally { setIsSending(false); }
  }, [activeChannelId, isSending, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashPicker) {
      const filtered = commands.filter((cmd) => cmd.type === 1 && cmd.name.startsWith(slashQuery.toLowerCase())).slice(0, 10);
      if (filtered.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((prev) => Math.min(filtered.length - 1, prev + 1));
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          handleSlashSelect(filtered[slashIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashPicker(false);
        return;
      }
      // No matching commands — fall through to normal send
    }

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

  // Compute placeholder text
  const dmChannel = selectedDMId ? dmChannels.find((d) => d.id === selectedDMId) : null;
  const dmRecipient = dmChannel?.recipients?.[0];

  const placeholder = selectedChannel
    ? `Message #${selectedChannel.name}`
    : dmRecipient
      ? `Message @${dmRecipient.displayName || dmRecipient.username}`
      : 'Message';

  return (
    <div className="shrink-0 px-4 pb-2">
      {/* Reply bar */}
      {replyingTo && (
        <div className="mb-2 flex items-center gap-2 rounded bg-[var(--bg-secondary)] px-3 py-2 text-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 00-4-4H4" />
          </svg>
          <span className="text-[var(--text-muted)]">Replying to</span>
          <span className="font-medium text-[var(--text-primary)]">
            {replyingTo.author?.displayName || replyingTo.author?.username || 'Unknown'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
            {replyingTo.content.length > 80 ? replyingTo.content.slice(0, 80) + '...' : replyingTo.content}
          </span>
          <button
            onClick={() => setReplyingTo(null)}
            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* File preview */}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file, i) => {
            const isImage = file.type.startsWith('image/');
            if (isImage) {
              return (
                <div key={i} className="group relative h-24 w-24 overflow-hidden rounded-lg bg-[var(--bg-secondary)]">
                  <img
                    src={previewUrls[i]}
                    alt={file.name}
                    className="h-full w-full object-cover"
                  />
                  <button
                    onClick={() => removeFile(i)}
                    className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/80"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            }
            return (
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
            );
          })}
        </div>
      )}

      <div
        className={`relative flex items-end rounded-lg bg-[var(--bg-input)] ${isDragOver ? 'ring-2 ring-[var(--accent)]' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Slash command picker popup */}
        {showSlashPicker && selectedServerId && commands.length > 0 && (
          <SlashCommandPicker
            commands={commands}
            query={slashQuery}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
            onDismiss={() => setShowSlashPicker(false)}
          />
        )}

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
        <div className="flex h-[44px] shrink-0 items-center self-end ml-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
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
        </div>
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
            checkSlashContext(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onClick={(e) => {
            const target = e.target as HTMLTextAreaElement;
            checkMentionContext(target.value, target.selectionStart);
          }}
          placeholder={placeholder}
          rows={1}
          enterKeyHint="send"
          className="max-h-[300px] min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
        />

        {/* GIF + Emoji + Send buttons */}
        <div className="flex h-[44px] shrink-0 items-center self-end mr-1">
          {gifEnabled && <GifPicker onSelect={handleGifSelect} />}
          <EmojiInputPicker onSelect={insertEmoji} />
          <button
            onClick={handleSend}
            disabled={isSending || (!content.trim() && files.length === 0)}
            className="ml-0.5 rounded p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-30 disabled:hover:text-[var(--text-muted)]"
            title="Send message"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
