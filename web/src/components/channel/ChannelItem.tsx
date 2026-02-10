import { useState, useRef, useEffect, type MouseEvent, type KeyboardEvent } from 'react';
import type { Channel } from '../../types';
import { useUnreadStore } from '../../stores/unreadStore';
import { apiUpdateChannel, apiDeleteChannel } from '../../api/client';
import { useServerStore } from '../../stores/serverStore';

interface ChannelItemProps {
  channel: Channel;
  isSelected: boolean;
  onClick: () => void;
  canManage?: boolean;
  serverId?: string;
}

export function ChannelItem({ channel, isSelected, onClick, canManage, serverId }: ChannelItemProps) {
  const hasUnread = useUnreadStore((s) => s.unreadChannels.has(channel.id));
  const mentionCount = useUnreadStore((s) => s.readStates[channel.id]?.mentionCount || 0);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(channel.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: MouseEvent) => {
    if (!canManage) return;
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowMenu(true);
  };

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [isEditing]);

  const handleRename = async () => {
    const trimmed = editName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed || !serverId || trimmed === channel.name) {
      setIsEditing(false);
      return;
    }
    try {
      const updated = await apiUpdateChannel(serverId, channel.id, { name: trimmed });
      useServerStore.getState().updateChannel(updated);
    } catch { /* handled */ }
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (!serverId) return;
    try {
      await apiDeleteChannel(serverId, channel.id);
    } catch { /* handled */ }
    setShowDeleteConfirm(false);
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRename();
    }
    if (e.key === 'Escape') {
      setIsEditing(false);
      setEditName(channel.name);
    }
  };

  if (isEditing) {
    return (
      <div className="px-2 py-1">
        <input
          ref={editRef}
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={handleEditKeyDown}
          onBlur={handleRename}
          className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
      </div>
    );
  }

  return (
    <>
      <button
        onClick={onClick}
        onContextMenu={handleContextMenu}
        className={`group flex w-full items-center gap-1.5 rounded-[4px] px-2 py-1.5 text-left transition-colors ${
          isSelected
            ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
            : hasUnread
              ? 'text-[var(--text-primary)] hover:bg-[var(--bg-input)]/50'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]'
        }`}
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
          className="shrink-0 opacity-60"
        >
          <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
        </svg>
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            hasUnread && !isSelected ? 'font-bold' : 'font-medium'
          }`}
        >
          {channel.name}
        </span>
        {mentionCount > 0 && (
          <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-bold text-white">
            {mentionCount}
          </span>
        )}
      </button>

      {/* Context menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] py-1 shadow-lg"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            onClick={() => {
              setShowMenu(false);
              setEditName(channel.name);
              setIsEditing(true);
            }}
            className="flex w-full items-center px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
          >
            Edit Channel
          </button>
          <button
            onClick={() => {
              setShowMenu(false);
              setShowDeleteConfirm(true);
            }}
            className="flex w-full items-center px-3 py-1.5 text-sm text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white"
          >
            Delete Channel
          </button>
        </div>
      )}

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-sm rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-bold text-[var(--text-primary)]">Delete Channel</h3>
            <p className="mb-4 text-sm text-[var(--text-secondary)]">
              Are you sure you want to delete <strong>#{channel.name}</strong>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-[3px] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="rounded-[3px] bg-[var(--danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
