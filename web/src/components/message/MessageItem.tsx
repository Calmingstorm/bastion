import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import type { Message } from '../../types';
import { MessageActions } from './MessageActions';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { AttachmentPreview } from './AttachmentPreview';
import { MarkdownRenderer } from './MarkdownRenderer';
import { GifEmbed } from './GifEmbed';
import { ReactionBar } from './ReactionBar';
import { UserContextMenu } from '../user/UserContextMenu';
import { UserProfileCard } from '../user/UserProfileCard';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';

interface MessageItemProps {
  message: Message;
  isCompact: boolean;
}

// Tenor/Giphy share page URL patterns (not direct media URLs — those are handled by MarkdownRenderer)
const TENOR_SHARE_RE = /^https?:\/\/(?:www\.)?tenor\.com\/view\/[a-zA-Z0-9_-]+-\d+$/;
const GIPHY_SHARE_RE = /^https?:\/\/(?:www\.)?giphy\.com\/gifs\/.+$/;

function isShareUrl(content: string): boolean {
  const trimmed = content.trim();
  return TENOR_SHARE_RE.test(trimmed) || GIPHY_SHARE_RE.test(trimmed);
}

const AVATAR_COLORS = [
  '#0ea5e9', // sky
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#22c55e', // green
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#a855f7', // purple
  '#6366f1', // indigo
];

function getAvatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFullTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const isToday = date.toDateString() === today.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;

  return `${date.toLocaleDateString([], {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  })} ${time}`;
}

export function MessageItem({ message, isCompact }: MessageItemProps) {
  const { author, content, createdAt, editedAt, attachments } = message;
  const displayName = author.displayName || author.username;
  const initial = displayName.charAt(0).toUpperCase();
  const avatarColor = getAvatarColor(author.id);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const servers = useServerStore((s) => s.servers);
  const server = servers.find((s) => s.id === selectedServerId);
  const currentUser = useAuthStore((s) => s.user);
  const canModerate = !!(server && currentUser && server.ownerId === currentUser.id);

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { editMessage, requestDeleteMessage } = useMessageStore();
  const setReplyingTo = useMessageStore((s) => s.setReplyingTo);

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.selectionStart = editRef.current.value.length;
    }
  }, [isEditing]);

  const handleEdit = () => {
    setEditContent(content);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    const trimmed = editContent.trim();
    if (!trimmed || trimmed === content) {
      setIsEditing(false);
      return;
    }
    try {
      await editMessage(message.channelId, message.id, trimmed);
      setIsEditing(false);
    } catch {
      // Error handled in store
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    }
    if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await requestDeleteMessage(message.channelId, message.id);
      setShowDeleteDialog(false);
    } catch {
      // Error handled in store
    } finally {
      setIsDeleting(false);
    }
  };

  const handleReply = () => {
    setReplyingTo(message);
  };

  const renderContent = () => {
    if (isEditing) {
      return (
        <div className="mt-1">
          <textarea
            ref={editRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={handleEditKeyDown}
            className="w-full resize-none rounded bg-[var(--bg-input)] p-2 text-[15px] text-[var(--text-primary)] outline-none"
            rows={2}
          />
          <div className="mt-1 flex gap-2 text-xs text-[var(--text-muted)]">
            <span>
              escape to{' '}
              <button onClick={() => setIsEditing(false)} className="text-[var(--accent)] hover:underline">
                cancel
              </button>
            </span>
            <span>
              enter to{' '}
              <button onClick={handleSaveEdit} className="text-[var(--accent)] hover:underline">
                save
              </button>
            </span>
          </div>
        </div>
      );
    }

    return (
      <>
        {/* Reply reference */}
        {message.replyTo && (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 00-4-4H4" />
            </svg>
            <span className="font-medium text-[var(--text-secondary)]">
              {message.replyTo.author.displayName || message.replyTo.author.username}
            </span>
            <span className="truncate max-w-xs">{message.replyTo.content}</span>
          </div>
        )}
        <div className="text-[15px] text-[var(--text-secondary)]">
          {isShareUrl(content) ? (
            <GifEmbed url={content.trim()} />
          ) : (
            <MarkdownRenderer content={content} />
          )}
          {editedAt && (
            <span className="ml-1 text-[10px] text-[var(--text-muted)]">
              (edited)
            </span>
          )}
        </div>
        {attachments && attachments.length > 0 && (
          <div className="flex flex-col gap-1">
            {attachments.map((att) => (
              <AttachmentPreview key={att.id} attachment={att} />
            ))}
          </div>
        )}
        <ReactionBar message={message} />
      </>
    );
  };

  if (isCompact) {
    return (
      <>
        <div className="group relative py-px pr-12 pl-[72px] hover:bg-[var(--bg-secondary)]/30">
          <MessageActions message={message} onEdit={handleEdit} onDelete={() => setShowDeleteDialog(true)} onReply={handleReply} />
          <span className="invisible absolute left-0 top-0.5 w-[68px] pr-3 text-right text-[11px] text-[var(--text-muted)] group-hover:visible">
            {formatTime(createdAt)}
          </span>
          <div className="min-w-0">
            {renderContent()}
          </div>
        </div>
        <DeleteConfirmDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={handleDelete}
          isDeleting={isDeleting}
        />
      </>
    );
  }

  return (
    <>
      <div className="group relative flex gap-4 py-1 pr-12 pl-4 mt-4 hover:bg-[var(--bg-secondary)]/30">
        <MessageActions message={message} onEdit={handleEdit} onDelete={() => setShowDeleteDialog(true)} onReply={handleReply} />
        {/* Avatar */}
        <UserContextMenu userId={author.id} username={author.username} serverId={selectedServerId || undefined} isOwner={server?.ownerId === author.id} canModerate={canModerate}>
          <UserProfileCard userId={author.id} serverId={selectedServerId || undefined} canModerate={canModerate} isOwner={server?.ownerId === author.id}>
            <div className="cursor-pointer">
              {author.avatarUrl ? (
                <img
                  src={author.avatarUrl}
                  alt={displayName}
                  className="mt-0.5 h-10 w-10 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div
                  className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ backgroundColor: avatarColor }}
                >
                  {initial}
                </div>
              )}
            </div>
          </UserProfileCard>
        </UserContextMenu>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <UserProfileCard userId={author.id} serverId={selectedServerId || undefined} canModerate={canModerate} isOwner={server?.ownerId === author.id}>
              <span className="font-medium text-[var(--text-primary)] hover:underline cursor-pointer">
                {displayName}
              </span>
            </UserProfileCard>
            <span className="text-xs text-[var(--text-muted)]">
              {formatFullTimestamp(createdAt)}
            </span>
          </div>
          {renderContent()}
        </div>
      </div>
      <DeleteConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}

export function DateSeparator({ date }: { date: string }) {
  const d = new Date(date);
  const formatted = d.toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="my-2 flex items-center gap-2 px-4">
      <div className="flex-1 border-t border-[var(--border)]" />
      <span className="text-xs font-semibold text-[var(--text-muted)]">
        {formatted}
      </span>
      <div className="flex-1 border-t border-[var(--border)]" />
    </div>
  );
}
