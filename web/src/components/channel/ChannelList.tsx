import { useState, useEffect, useCallback, useRef, type FormEvent, type KeyboardEvent } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { ChannelItem } from './ChannelItem';
import { InviteDialog } from '../server/InviteDialog';
import { ServerSettingsDialog } from '../server/ServerSettingsDialog';
import { UserPanel } from '../user/UserPanel';
import { apiGetCategories, apiCreateCategory, apiUpdateCategory, apiDeleteCategory, apiReorderChannels } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { usePermissionStore } from '../../stores/permissionStore';
import { PERMISSIONS } from '../../utils/permissions';
import { eventBus } from '../../utils/eventBus';
import type { Channel, ChannelCategory } from '../../types';
import { ConfirmDialog } from '../ui/ConfirmDialog';

function SortableChannelItem({ channel, isSelected, onClick, canManage, serverId, categories }: {
  channel: Channel;
  isSelected: boolean;
  onClick: () => void;
  canManage: boolean;
  serverId?: string;
  categories?: ChannelCategory[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: channel.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center">
      {canManage && (
        <button
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab px-0.5 text-[var(--text-muted)] opacity-0 hover:opacity-100 focus:opacity-100 group-hover:opacity-100"
          style={{ opacity: isDragging ? 1 : undefined }}
          tabIndex={-1}
        >
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="3" cy="2" r="1.5" /><circle cx="7" cy="2" r="1.5" />
            <circle cx="3" cy="8" r="1.5" /><circle cx="7" cy="8" r="1.5" />
            <circle cx="3" cy="14" r="1.5" /><circle cx="7" cy="14" r="1.5" />
          </svg>
        </button>
      )}
      <div className="min-w-0 flex-1">
        <ChannelItem
          channel={channel}
          isSelected={isSelected}
          onClick={onClick}
          canManage={canManage}
          serverId={serverId}
          categories={categories}
        />
      </div>
    </div>
  );
}

export function ChannelList() {
  // Targeted selectors to avoid cascading re-renders
  const servers = useServerStore((s) => s.servers);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const channels = useServerStore((s) => s.channels);
  const selectedChannelId = useServerStore((s) => s.selectedChannelId);
  const selectChannel = useServerStore((s) => s.selectChannel);
  const createChannel = useServerStore((s) => s.createChannel);
  const isLoadingChannels = useServerStore((s) => s.isLoadingChannels);
  const user = useAuthStore((s) => s.user);

  const [showCreate, setShowCreate] = useState(false);
  const [createInCategoryId, setCreateInCategoryId] = useState<string | null>(null);
  const [newChannelName, setNewChannelName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showCreateCategory, setShowCreateCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [isDeletingCategory, setIsDeletingCategory] = useState(false);
  const editCategoryRef = useRef<HTMLInputElement>(null);
  // The delete-category confirm is opened from a context menu whose portal holds
  // focus when the dialog captures it; hand the dialog the category's persistent
  // trigger to restore focus to. One shared dialog serves every category, so record
  // the triggering category's button (from this map) when delete is chosen.
  const categoryTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingReturnFocusRef = useRef<HTMLElement | null>(null);

  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const isOwner = selectedServer && user && selectedServer.ownerId === user.id;
  const serverPerms = usePermissionStore((s) => selectedServerId ? s.permissions[selectedServerId] ?? 0 : 0);
  const canManageChannels = !!isOwner || (serverPerms & PERMISSIONS.ManageChannels) === PERMISSIONS.ManageChannels;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !selectedServerId) return;

    const oldIndex = channels.findIndex((c) => c.id === active.id);
    const newIndex = channels.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Optimistic reorder in store -- a scoped, lineage-claiming write.
    const reordered = [...channels];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    useServerStore.getState().setChannelsScoped(selectedServerId, reordered);

    // Persist to backend
    const positions = reordered.map((c, i) => ({ id: c.id, position: i }));
    const generation = captureSessionGeneration();
    try {
      await apiReorderChannels(selectedServerId, positions);
    } catch {
      // Revert on failure -- but never into a different session OR server scope: a
      // late failure after a switch must not restore the OLD server's channel list
      // over the new one. setChannelsScoped enforces the scope check.
      if (isSessionGenerationCurrent(generation)) {
        useServerStore.getState().setChannelsScoped(selectedServerId, channels);
      }
    }
  }, [channels, selectedServerId]);

  const categoriesSeqRef = useRef(0);
  const fetchCategories = useCallback(() => {
    if (!selectedServerId) {
      // Empty scope invalidates outstanding reads: a held old-server response
      // must not repopulate the (cleared) categories. (Post-round-18 the zombie
      // state is also invisible -- the clear-on-change wipes it at any re-scope --
      // so this claim closes the latent state rather than a visible defect.)
      categoriesSeqRef.current += 1;
      return;
    }
    // Owned by session AND recency: a fetch settling after an identity boundary
    // must not populate the new session's UI, and an OLDER fetch settling after a
    // newer one must not overwrite its categories.
    const generation = captureSessionGeneration();
    const seq = ++categoriesSeqRef.current;
    apiGetCategories(selectedServerId).then((cats) => {
      if (seq !== categoriesSeqRef.current || !isSessionGenerationCurrent(generation)) return;
      setCategories(cats.sort((a, b) => a.position - b.position));
    }).catch(() => {});
  }, [selectedServerId]);

  // Fetch categories when server changes -- clearing FIRST, so server A's
  // categories are never displayed under server B (even if B's fetch fails).
  useEffect(() => {
    setCategories([]);
    fetchCategories();
  }, [fetchCategories]);

  // Listen for category WS events to refetch
  useEffect(() => {
    const handler = () => fetchCategories();
    eventBus.on('bastion:category-update', handler);
    return () => eventBus.off('bastion:category-update', handler);
  }, [fetchCategories]);

  const toggleCategory = (catId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const handleCreateChannel = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newChannelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed || !selectedServerId) return;

    setIsCreating(true);
    // Workflow-owned: a create settling after an identity boundary must not run the
    // success UI (the store action rejects with SessionSupersededError on stale, and
    // this covers the window between its settlement and this continuation).
    const generation = captureSessionGeneration();
    try {
      await createChannel(selectedServerId, trimmed, undefined, createInCategoryId || undefined);
      if (!isSessionGenerationCurrent(generation)) return;
      setNewChannelName('');
      setShowCreate(false);
      setCreateInCategoryId(null);
    } catch {
      // Real errors are surfaced by the store; SessionSupersededError is neither a
      // success nor an error of this session's concern.
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreateCategory = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed || !selectedServerId) return;

    // Owned by session AND server scope: a continuation settling after a server
    // switch must not refetch (or reselect) the OLD server under the new one.
    const generation = captureSessionGeneration();
    const serverIdAtStart = selectedServerId;
    try {
      await apiCreateCategory(selectedServerId, trimmed);
      if (!isSessionGenerationCurrent(generation)) return;
      if (useServerStore.getState().selectedServerId !== serverIdAtStart) return;
      setNewCategoryName('');
      setShowCreateCategory(false);
      fetchCategories();
    } catch {
      // silently fail
    }
  };

  const handleRenameCategory = async (catId: string) => {
    const trimmed = editCategoryName.trim();
    if (!trimmed || !selectedServerId) {
      setEditingCategoryId(null);
      return;
    }
    const cat = categories.find((c) => c.id === catId);
    if (cat && trimmed === cat.name) {
      setEditingCategoryId(null);
      return;
    }
    const generation = captureSessionGeneration();
    const serverIdAtStart = selectedServerId;
    const stillOurs = () => isSessionGenerationCurrent(generation)
      && useServerStore.getState().selectedServerId === serverIdAtStart;
    try {
      await apiUpdateCategory(selectedServerId, catId, { name: trimmed });
      if (stillOurs()) fetchCategories();
    } catch {
      // silently fail
    }
    // Local editing state is scope-owned too: after a switch, this continuation
    // must not dismiss editing state belonging to the NEW scope.
    if (stillOurs()) setEditingCategoryId(null);
  };

  const handleDeleteCategory = async () => {
    if (!deletingCategoryId || !selectedServerId) return;
    setIsDeletingCategory(true); // locks the dialog so it can't be dismissed mid-request
    const generation = captureSessionGeneration();
    const serverIdAtStart = selectedServerId;
    const stillOurs = () => isSessionGenerationCurrent(generation)
      && useServerStore.getState().selectedServerId === serverIdAtStart;
    try {
      await apiDeleteCategory(selectedServerId, deletingCategoryId);
      // A stale delete completing must not refetch into -- or reselect within --
      // the NEW session or a DIFFERENT server scope.
      if (stillOurs()) {
        fetchCategories();
        // Channels in deleted category become uncategorized — refetch channels
        useServerStore.getState().selectServer(selectedServerId);
      }
    } catch {
      // silently fail
    }
    // Deletion/pending state is scope-owned: after a switch, this continuation
    // must not dismiss a deletion dialog the user opened in the NEW scope.
    if (stillOurs()) {
      setIsDeletingCategory(false);
      setDeletingCategoryId(null);
    }
  };

  const handleEditCategoryKeyDown = (e: KeyboardEvent<HTMLInputElement>, catId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameCategory(catId);
    }
    if (e.key === 'Escape') {
      setEditingCategoryId(null);
    }
  };

  useEffect(() => {
    if (editingCategoryId && editCategoryRef.current) {
      editCategoryRef.current.focus();
      editCategoryRef.current.select();
    }
  }, [editingCategoryId]);

  const startCreateInCategory = (catId: string | null) => {
    setCreateInCategoryId(catId);
    setNewChannelName('');
    setShowCreate(true);
    // Ensure category is expanded
    if (catId) {
      setCollapsedCategories((prev) => {
        const next = new Set(prev);
        next.delete(catId);
        return next;
      });
    }
  };

  const channelCreateForm = (
    <form onSubmit={handleCreateChannel} className="mb-1 px-1">
      <input
        type="text"
        value={newChannelName}
        onChange={(e) => setNewChannelName(e.target.value)}
        placeholder="new-channel"
        autoFocus
        disabled={isCreating}
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
        onBlur={() => {
          if (!newChannelName.trim()) {
            setShowCreate(false);
            setCreateInCategoryId(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setNewChannelName('');
            setShowCreate(false);
            setCreateInCategoryId(null);
          }
        }}
      />
    </form>
  );

  if (!selectedServer) {
    return (
      <div className="flex h-full w-60 flex-col bg-[var(--bg-secondary)]">
        <div className="flex h-12 items-center border-b border-[var(--border)] px-4">
          <span className="text-sm font-semibold text-[var(--text-muted)]">
            Select a server
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-[var(--text-muted)]">
            Select a server from the sidebar or create a new one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-60 flex-col bg-[var(--bg-secondary)]">
      {/* Server name header */}
      <div className="flex h-12 items-center justify-between border-b border-[var(--border)] px-4">
        <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">
          {selectedServer.name}
        </h2>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => setInviteOpen(true)}
            className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
            title="Invite People"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </svg>
          </button>
          {(!!isOwner || (serverPerms & PERMISSIONS.ManageServer) === PERMISSIONS.ManageServer) && (
            <button
              onClick={() => setSettingsOpen(true)}
              className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
              title="Server Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {isLoadingChannels ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
          </div>
        ) : channels.length === 0 && categories.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-[var(--text-muted)]">
            No channels yet.
            {canManageChannels && ' Click + to create one.'}
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={channels.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              {/* Uncategorized channels */}
              {(() => {
                const uncategorized = channels.filter((c) => !c.categoryId);
                if (uncategorized.length === 0 && categories.length > 0 && !showCreate) return null;
                return (
                  <div className="mb-2">
                    <div className="mb-1 flex items-center justify-between px-1">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                        Text Channels
                      </span>
                      {canManageChannels && (
                        <div className="flex gap-0.5">
                          <button
                            onClick={() => setShowCreateCategory(!showCreateCategory)}
                            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                            title="Create Category"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                              <line x1="12" y1="11" x2="12" y2="17" />
                              <line x1="9" y1="14" x2="15" y2="14" />
                            </svg>
                          </button>
                          <button
                            onClick={() => startCreateInCategory(null)}
                            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                            title="Create Channel"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Create category inline form */}
                    {showCreateCategory && (
                      <form onSubmit={handleCreateCategory} className="mb-1 px-1">
                        <input
                          type="text"
                          value={newCategoryName}
                          onChange={(e) => setNewCategoryName(e.target.value)}
                          placeholder="Category name"
                          autoFocus
                          className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                          onBlur={() => {
                            if (!newCategoryName.trim()) {
                              setShowCreateCategory(false);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setNewCategoryName('');
                              setShowCreateCategory(false);
                            }
                          }}
                        />
                      </form>
                    )}
                    {/* Create channel form (uncategorized) */}
                    {showCreate && createInCategoryId === null && channelCreateForm}
                    <div className="space-y-0.5">
                      {uncategorized.map((channel) => (
                        <SortableChannelItem
                          key={channel.id}
                          channel={channel}
                          isSelected={channel.id === selectedChannelId}
                          onClick={() => selectChannel(channel.id)}
                          canManage={canManageChannels}
                          serverId={selectedServerId || undefined}
                          categories={categories}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Categorized channels */}
              {categories.map((cat) => {
                const catChannels = channels.filter((c) => c.categoryId === cat.id);
                const isCollapsed = collapsedCategories.has(cat.id);
                const isEditingThis = editingCategoryId === cat.id;
                return (
                  <div key={cat.id} className="mb-2">
                    <div className="mb-1 flex items-center justify-between px-1">
                      {isEditingThis ? (
                        <input
                          ref={editCategoryRef}
                          type="text"
                          value={editCategoryName}
                          onChange={(e) => setEditCategoryName(e.target.value)}
                          onKeyDown={(e) => handleEditCategoryKeyDown(e, cat.id)}
                          onBlur={() => handleRenameCategory(cat.id)}
                          className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-1 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      ) : (
                        <ContextMenu.Root>
                          <ContextMenu.Trigger asChild>
                            <button
                              ref={(el) => {
                                categoryTriggerRefs.current[cat.id] = el;
                              }}
                              onClick={() => toggleCategory(cat.id)}
                              className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                className={`shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                              >
                                <path d="M7 10l5 5 5-5z" />
                              </svg>
                              <span className="truncate">{cat.name}</span>
                            </button>
                          </ContextMenu.Trigger>
                          {canManageChannels && (
                            <ContextMenu.Portal>
                              <ContextMenu.Content className="z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-xl">
                                <ContextMenu.Item
                                  onSelect={() => {
                                    setEditCategoryName(cat.name);
                                    setEditingCategoryId(cat.id);
                                  }}
                                  className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
                                >
                                  Edit Category
                                </ContextMenu.Item>
                                <ContextMenu.Item
                                  onSelect={() => startCreateInCategory(cat.id)}
                                  className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
                                >
                                  Create Channel
                                </ContextMenu.Item>
                                <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                                <ContextMenu.Item
                                  onSelect={() => {
                                    pendingReturnFocusRef.current = categoryTriggerRefs.current[cat.id] ?? null;
                                    setDeletingCategoryId(cat.id);
                                  }}
                                  className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white"
                                >
                                  Delete Category
                                </ContextMenu.Item>
                              </ContextMenu.Content>
                            </ContextMenu.Portal>
                          )}
                        </ContextMenu.Root>
                      )}
                      {canManageChannels && !isEditingThis && (
                        <button
                          onClick={() => startCreateInCategory(cat.id)}
                          className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                          title="Create Channel"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {!isCollapsed && (
                      <>
                        {/* Create channel form (in this category) */}
                        {showCreate && createInCategoryId === cat.id && channelCreateForm}
                        <div className="space-y-0.5">
                          {catChannels.map((channel) => (
                            <SortableChannelItem
                              key={channel.id}
                              channel={channel}
                              isSelected={channel.id === selectedChannelId}
                              onClick={() => selectChannel(channel.id)}
                              canManage={canManageChannels}
                              serverId={selectedServerId || undefined}
                              categories={categories}
                            />
                          ))}
                        </div>
                        {catChannels.length === 0 && !showCreate && (
                          <p className="px-3 py-1 text-xs text-[var(--text-muted)]">No channels</p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* User panel at bottom */}
      <UserPanel />

      {/* Dialogs */}
      {selectedServerId && (
        <>
          <InviteDialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
            serverId={selectedServerId}
          />
          <ServerSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            serverId={selectedServerId}
          />
        </>
      )}

      <ConfirmDialog
        open={!!deletingCategoryId}
        onOpenChange={(open) => {
          if (!open) setDeletingCategoryId(null);
        }}
        onConfirm={handleDeleteCategory}
        title="Delete Category"
        description="Are you sure you want to delete this category? Channels in this category will become uncategorized."
        returnFocusRef={pendingReturnFocusRef}
        isPending={isDeletingCategory}
      />
    </div>
  );
}
