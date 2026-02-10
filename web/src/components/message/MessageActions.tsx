import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import type { Message } from '../../types';

interface MessageActionsProps {
  message: Message;
  onEdit: () => void;
  onDelete: () => void;
}

export function MessageActions({ message, onEdit, onDelete }: MessageActionsProps) {
  const { user } = useAuthStore();
  const { servers, selectedServerId } = useServerStore();

  const isAuthor = user?.id === message.author.id;
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const isOwner = selectedServer && user && selectedServer.ownerId === user.id;
  const canDelete = isAuthor || isOwner;

  if (!isAuthor && !canDelete) return null;

  return (
    <div className="absolute -top-3 right-4 flex items-center gap-0.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
      {isAuthor && (
        <button
          onClick={onEdit}
          className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
          title="Edit message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      )}
      {canDelete && (
        <button
          onClick={onDelete}
          className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
          title="Delete message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      )}
    </div>
  );
}
