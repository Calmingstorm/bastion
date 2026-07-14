import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Channel, ChannelCategory } from '../../types';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUnreadStore } from '../../stores/unreadStore';
import { apiUpdateChannel, apiDeleteChannel } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { useServerStore } from '../../stores/serverStore';

interface ChannelItemProps {
  channel: Channel;
  isSelected: boolean;
  onClick: () => void;
  canManage?: boolean;
  serverId?: string;
  categories?: ChannelCategory[];
}

export function ChannelItem({ channel, isSelected, onClick, canManage, serverId, categories }: ChannelItemProps) {
  const hasUnread = useUnreadStore((s) => s.unreadChannels.has(channel.id));
  const mentionCount = useUnreadStore((s) => s.readStates[channel.id]?.mentionCount || 0);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(channel.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  // The delete confirm is opened from the context menu; its portal holds focus when
  // the dialog captures it, so we hand the dialog this persistent trigger to restore
  // focus to on Escape/Cancel (on delete the channel unmounts -> app fallback).
  const triggerRef = useRef<HTMLButtonElement>(null);

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
    // Workflow-owned by the session it started under: an update settling after an
    // identity boundary must not rewrite a same-ID channel the new session loaded.
    const generation = captureSessionGeneration();
    try {
      const updated = await apiUpdateChannel(serverId, channel.id, { name: trimmed });
      if (isSessionGenerationCurrent(generation)) {
        useServerStore.getState().updateChannel(updated);
      }
    } catch { /* handled */ }
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (!serverId) return;
    setIsDeleting(true); // locks the dialog so it can't be dismissed mid-request
    // Channel ids are stable across sessions: if the delete settles after an identity
    // boundary, removing by id would delete a channel the NEW session has loaded.
    const generation = captureSessionGeneration();
    try {
      await apiDeleteChannel(serverId, channel.id);
      if (isSessionGenerationCurrent(generation)) {
        useServerStore.getState().removeChannel(channel.id);
      }
    } catch { /* handled */ }
    setIsDeleting(false);
    setShowDeleteConfirm(false);
  };

  const handleMoveToCategory = async (categoryId: string | null) => {
    if (!serverId) return;
    const generation = captureSessionGeneration();
    try {
      const updated = await apiUpdateChannel(serverId, channel.id, {
        categoryId: categoryId ?? '',
      });
      if (isSessionGenerationCurrent(generation)) {
        useServerStore.getState().updateChannel(updated);
      }
    } catch { /* handled */ }
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

  const channelButton = (
    <button
      ref={triggerRef}
      onClick={onClick}
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
  );

  if (!canManage) {
    return (
      <>
        {channelButton}
        <ConfirmDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
          onConfirm={handleDelete}
          returnFocusRef={triggerRef}
          isPending={isDeleting}
          title="Delete Channel"
          description={
            <>
              Are you sure you want to delete <strong>#{channel.name}</strong>? This cannot be undone.
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          {channelButton}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-xl">
            <ContextMenu.Item
              onSelect={() => {
                setEditName(channel.name);
                setIsEditing(true);
              }}
              className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
            >
              Edit Channel
            </ContextMenu.Item>
            {categories && categories.length > 0 && (
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className="flex w-full cursor-default items-center justify-between rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white">
                  Move to Category
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="ml-2">
                    <path d="M10 6l6 6-6 6z" />
                  </svg>
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className="z-50 min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-xl">
                    <ContextMenu.Item
                      onSelect={() => handleMoveToCategory(null)}
                      className={`flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none hover:bg-[var(--accent)] hover:text-white ${
                        !channel.categoryId ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      No Category
                    </ContextMenu.Item>
                    <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                    {categories.map((cat) => (
                      <ContextMenu.Item
                        key={cat.id}
                        onSelect={() => handleMoveToCategory(cat.id)}
                        className={`flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none hover:bg-[var(--accent)] hover:text-white ${
                          channel.categoryId === cat.id ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        {cat.name}
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            )}
            <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
            <ContextMenu.Item
              onSelect={() => setShowDeleteConfirm(true)}
              className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white"
            >
              Delete Channel
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        onConfirm={handleDelete}
        returnFocusRef={triggerRef}
        isPending={isDeleting}
        title="Delete Channel"
        description={
          <>
            Are you sure you want to delete <strong>#{channel.name}</strong>? This cannot be undone.
          </>
        }
      />
    </>
  );
}
