import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { MessageItem, DateSeparator } from './MessageItem';
import { TypingIndicator } from './TypingIndicator';
import { SearchDialog } from '../search/SearchDialog';
import { PinnedMessages } from './PinnedMessages';
import { PresenceDot } from '../user/PresenceDot';
import type { Message } from '../../types';

function isSameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function shouldGroupWithPrevious(
  current: Message,
  previous: Message | undefined
): boolean {
  if (!previous) return false;
  if (previous.author.id !== current.author.id) return false;

  // Group messages within 7 minutes of each other
  const prevTime = new Date(previous.createdAt).getTime();
  const currTime = new Date(current.createdAt).getTime();
  if (currTime - prevTime > 7 * 60 * 1000) return false;

  return true;
}

interface MessageListProps {
  onToggleMembers?: () => void;
  onToggleSidebar?: () => void;
}

const EMPTY_MESSAGES: Message[] = [];

export function MessageList({ onToggleMembers, onToggleSidebar }: MessageListProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);

  // Ctrl+K keyboard shortcut for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Use targeted selectors to avoid re-renders from unrelated store changes
  const selectedChannelId = useServerStore((s) => s.selectedChannelId);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const channels = useServerStore((s) => s.channels);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const dmChannels = useDMStore((s) => s.dmChannels);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const ackChannel = useUnreadStore((s) => s.ackChannel);

  // Determine active channel: server channel or DM channel
  const activeChannelId = selectedChannelId || selectedDMId;
  const isDM = !!selectedDMId && !selectedChannelId;

  // DM recipient info
  const dmChannel = isDM ? dmChannels.find((d) => d.id === selectedDMId) : null;
  const dmRecipient = dmChannel?.recipients?.[0];
  const dmRecipientName = dmRecipient
    ? dmRecipient.displayName || dmRecipient.username
    : 'Unknown';

  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  // Select per-channel data with stable empty fallbacks
  const channelMessages = useMessageStore(
    (s) => (activeChannelId ? s.messages[activeChannelId] : null) || EMPTY_MESSAGES
  );
  const channelHasMore = useMessageStore(
    (s) => (activeChannelId ? s.hasMore[activeChannelId] ?? true : false)
  );
  const channelIsLoading = useMessageStore(
    (s) => (activeChannelId ? s.isLoading[activeChannelId] ?? false : false)
  );

  const { containerRef, scrollToBottomPersistent } = useAutoScroll([
    channelMessages.length,
    activeChannelId,
  ]);

  const loadingOlderRef = useRef(false);

  // Build a username map for typing indicators
  const usernameMap = useMemo(() => {
    const map: Record<string, string> = {};
    channelMessages.forEach((msg) => {
      if (!map[msg.author.id]) {
        map[msg.author.id] = msg.author.displayName || msg.author.username;
      }
    });
    return map;
  }, [channelMessages]);

  // Always scroll to bottom after the current user sends a message
  useEffect(() => {
    const handler = () => scrollToBottomPersistent();
    window.addEventListener('bastion:message-sent', handler);
    return () => window.removeEventListener('bastion:message-sent', handler);
  }, [scrollToBottomPersistent]);

  // Fetch messages when channel changes
  useEffect(() => {
    if (activeChannelId && channelMessages.length === 0 && !channelIsLoading) {
      fetchMessages(activeChannelId).then(() => {
        // Scroll to bottom on initial load — use persistent version to
        // keep re-scrolling as images/GIFs/embeds load asynchronously
        scrollToBottomPersistent();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId]);

  // Auto-ack when channel is selected and has messages
  useEffect(() => {
    if (activeChannelId && channelMessages.length > 0) {
      const lastMsg = channelMessages[channelMessages.length - 1];
      ackChannel(activeChannelId, lastMsg.id);
    }
    // Only ack on channel switch or when new messages arrive (length changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId, channelMessages.length]);

  // Infinite scroll - load older messages
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !activeChannelId) return;
    if (loadingOlderRef.current || channelIsLoading || !channelHasMore) return;

    if (container.scrollTop < 100) {
      const oldestMessage = channelMessages[0];
      if (oldestMessage) {
        loadingOlderRef.current = true;
        const prevScrollHeight = container.scrollHeight;

        fetchMessages(activeChannelId, oldestMessage.id).then(() => {
          // Maintain scroll position after prepending
          requestAnimationFrame(() => {
            if (container) {
              const newScrollHeight = container.scrollHeight;
              container.scrollTop = newScrollHeight - prevScrollHeight;
            }
            loadingOlderRef.current = false;
          });
        });
      }
    }

    // Ack when scrolled to bottom
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    if (isAtBottom && channelMessages.length > 0) {
      const lastMsg = channelMessages[channelMessages.length - 1];
      ackChannel(activeChannelId, lastMsg.id);
    }
  }, [
    containerRef,
    activeChannelId,
    channelIsLoading,
    channelHasMore,
    channelMessages,
    fetchMessages,
    ackChannel,
  ]);

  if (!activeChannelId) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-secondary)]">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--text-muted)]"
            >
              <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">
            No Channel Selected
          </h3>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Select a channel to start chatting
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-primary)]">
      {/* Channel header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex min-w-0 items-center">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="mr-2 shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
              title="Open sidebar"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          )}
          {isDM ? (
            <>
              {/* DM header: @ icon + recipient name + presence */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mr-2 shrink-0 text-[var(--text-muted)]"
              >
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <h3 className="font-semibold text-[var(--text-primary)]">
                {dmRecipientName}
              </h3>
              {dmRecipient && (
                <PresenceDot userId={dmRecipient.id} className="ml-2" />
              )}
            </>
          ) : (
            <>
              {/* Server channel header: # icon + channel name + topic */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mr-2 shrink-0 text-[var(--text-muted)]"
              >
                <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
              </svg>
              <h3 className="font-semibold text-[var(--text-primary)]">
                {selectedChannel?.name || 'Unknown Channel'}
              </h3>
              {selectedChannel?.topic && (
                <>
                  <div className="mx-3 h-6 w-[1px] bg-[var(--border)]" />
                  <span className="truncate text-sm text-[var(--text-muted)]">
                    {selectedChannel.topic}
                  </span>
                </>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Pinned messages button */}
          <button
            onClick={() => setPinsOpen(true)}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
            title="Pinned Messages"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M9 2h6l-1 7h4l-7 8V10H7l2-8z" />
            </svg>
          </button>

          {/* Search button */}
          <button
            onClick={() => setSearchOpen(true)}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
            title="Search (Ctrl+K)"
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
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>

          {onToggleMembers && (
            <button
              onClick={onToggleMembers}
              className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
              title="Toggle Member List"
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
              >
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 00-3-3.87" />
                <path d="M16 3.13a4 4 0 010 7.75" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto pb-6"
      >
        {/* Loading indicator at top */}
        {channelIsLoading && (
          <div className="flex items-center justify-center py-4">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
          </div>
        )}

        {/* Welcome message at top when no more messages */}
        {!channelHasMore && !channelIsLoading && (
          <div className="px-4 pt-8 pb-4">
            <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--bg-input)]">
              {isDM ? (
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-[var(--text-muted)]"
                >
                  <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              ) : (
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-[var(--text-muted)]"
                >
                  <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
                </svg>
              )}
            </div>
            {isDM ? (
              <>
                <h2 className="text-3xl font-bold text-[var(--text-primary)]">
                  {dmRecipientName}
                </h2>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  This is the beginning of your direct message history with{' '}
                  <strong>{dmRecipientName}</strong>.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-3xl font-bold text-[var(--text-primary)]">
                  Welcome to #{selectedChannel?.name || 'channel'}!
                </h2>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  This is the start of the #{selectedChannel?.name || 'channel'}{' '}
                  channel.
                </p>
              </>
            )}
          </div>
        )}

        {/* Messages */}
        {channelMessages.map((msg, index) => {
          const prev = index > 0 ? channelMessages[index - 1] : undefined;
          const showDateSep =
            !prev || !isSameDay(prev.createdAt, msg.createdAt);
          const isCompact =
            !showDateSep && shouldGroupWithPrevious(msg, prev);

          return (
            <div key={msg.id}>
              {showDateSep && <DateSeparator date={msg.createdAt} />}
              <MessageItem message={msg} isCompact={isCompact} />
            </div>
          );
        })}

        {/* Empty state */}
        {channelMessages.length === 0 && !channelIsLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-[var(--text-muted)]">
              {isDM
                ? 'Send a message to start the conversation.'
                : 'No messages yet. Say something!'}
            </p>
          </div>
        )}
      </div>

      {/* Typing indicator */}
      {activeChannelId && (
        <TypingIndicator
          channelId={activeChannelId}
          usernames={usernameMap}
        />
      )}

      {/* Search dialog */}
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Pinned messages panel */}
      {activeChannelId && (
        <PinnedMessages
          open={pinsOpen}
          onOpenChange={setPinsOpen}
          channelId={activeChannelId}
        />
      )}
    </div>
  );
}
