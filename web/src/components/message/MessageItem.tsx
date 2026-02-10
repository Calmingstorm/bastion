import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import type { Message } from '../../types';
import { MessageActions } from './MessageActions';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { AttachmentPreview } from './AttachmentPreview';
import { useMessageStore } from '../../stores/messageStore';

interface MessageItemProps {
  message: Message;
  isCompact: boolean;
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

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { editMessage, requestDeleteMessage } = useMessageStore();

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
        <p className="whitespace-pre-wrap break-words text-[15px] text-[var(--text-secondary)]">
          {content}
          {editedAt && (
            <span className="ml-1 text-[10px] text-[var(--text-muted)]">
              (edited)
            </span>
          )}
        </p>
        {attachments && attachments.length > 0 && (
          <div className="flex flex-col gap-1">
            {attachments.map((att) => (
              <AttachmentPreview key={att.id} attachment={att} />
            ))}
          </div>
        )}
      </>
    );
  };

  if (isCompact) {
    return (
      <>
        <div className="group relative py-px pr-12 pl-[72px] hover:bg-[var(--bg-secondary)]/30">
          <MessageActions message={message} onEdit={handleEdit} onDelete={() => setShowDeleteDialog(true)} />
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
        <MessageActions message={message} onEdit={handleEdit} onDelete={() => setShowDeleteDialog(true)} />
        {/* Avatar */}
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

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-[var(--text-primary)] hover:underline cursor-pointer">
              {displayName}
            </span>
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
