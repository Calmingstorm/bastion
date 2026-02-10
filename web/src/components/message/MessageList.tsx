import { useEffect, useCallback, useRef, useMemo } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { MessageItem, DateSeparator } from './MessageItem';
import { TypingIndicator } from './TypingIndicator';
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
}

export function MessageList({ onToggleMembers }: MessageListProps) {
  const { selectedChannelId, channels } = useServerStore();
  const { messages, hasMore, isLoading, fetchMessages } = useMessageStore();
  const { ackChannel } = useUnreadStore();

  const channelMessages = selectedChannelId
    ? messages[selectedChannelId] || []
    : [];
  const channelHasMore = selectedChannelId
    ? hasMore[selectedChannelId] ?? true
    : false;
  const channelIsLoading = selectedChannelId
    ? isLoading[selectedChannelId] ?? false
    : false;
  const selectedChannel = channels.find((c) => c.id === selectedChannelId);

  const { containerRef, scrollToBottom } = useAutoScroll([
    channelMessages.length,
    selectedChannelId,
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

  // Fetch messages when channel changes
  useEffect(() => {
    if (selectedChannelId && !messages[selectedChannelId]) {
      fetchMessages(selectedChannelId).then(() => {
        // Scroll to bottom on initial load
        setTimeout(scrollToBottom, 50);
      });
    }
  }, [selectedChannelId, messages, fetchMessages, scrollToBottom]);

  // Auto-ack when channel is selected and has messages
  useEffect(() => {
    if (selectedChannelId && channelMessages.length > 0) {
      const lastMsg = channelMessages[channelMessages.length - 1];
      ackChannel(selectedChannelId, lastMsg.id);
    }
  }, [selectedChannelId, channelMessages, ackChannel]);

  // Infinite scroll - load older messages
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !selectedChannelId) return;
    if (loadingOlderRef.current || channelIsLoading || !channelHasMore) return;

    if (container.scrollTop < 100) {
      const oldestMessage = channelMessages[0];
      if (oldestMessage) {
        loadingOlderRef.current = true;
        const prevScrollHeight = container.scrollHeight;

        fetchMessages(selectedChannelId, oldestMessage.id).then(() => {
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
      ackChannel(selectedChannelId, lastMsg.id);
    }
  }, [
    containerRef,
    selectedChannelId,
    channelIsLoading,
    channelHasMore,
    channelMessages,
    fetchMessages,
    ackChannel,
  ]);

  if (!selectedChannelId) {
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
    <div className="flex flex-1 flex-col bg-[var(--bg-primary)]">
      {/* Channel header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex min-w-0 items-center">
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
        </div>
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
            <h2 className="text-3xl font-bold text-[var(--text-primary)]">
              Welcome to #{selectedChannel?.name || 'channel'}!
            </h2>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              This is the start of the #{selectedChannel?.name || 'channel'}{' '}
              channel.
            </p>
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
              No messages yet. Say something!
            </p>
          </div>
        )}
      </div>

      {/* Typing indicator */}
      {selectedChannelId && (
        <TypingIndicator
          channelId={selectedChannelId}
          usernames={usernameMap}
        />
      )}
    </div>
  );
}
