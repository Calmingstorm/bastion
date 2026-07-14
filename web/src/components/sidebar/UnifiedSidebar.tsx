import { useState, useEffect, useCallback, useRef, type FormEvent, type KeyboardEvent } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useAuthStore } from '../../stores/authStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { resolveMediaUrl } from '../../platform';
import { ChannelItem } from '../channel/ChannelItem';
import { PresenceDot } from '../user/PresenceDot';
import { UserPanel } from '../user/UserPanel';
import { CreateServerDialog } from '../server/CreateServerDialog';
import { InviteDialog } from '../server/InviteDialog';
import { ServerSettingsDialog } from '../server/ServerSettingsDialog';
import { NewDMDialog } from '../dm/NewDMDialog';
import { apiGetCategories, apiCreateCategory, apiUpdateCategory, apiDeleteCategory, apiCreateChannel } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { usePermissionStore } from '../../stores/permissionStore';
import { PERMISSIONS } from '../../utils/permissions';
import { eventBus } from '../../utils/eventBus';
import bastionLogo from '../../assets/bastion-logo.svg';
import type { ChannelCategory } from '../../types';
import { ConfirmDialog } from '../ui/ConfirmDialog';

const DM_VISIBLE_COUNT = 8;

const ICON_COLORS = [
  '#0ea5e9', '#06b6d4', '#14b8a6', '#22c55e', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1',
];

function getColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

export function UnifiedSidebar() {
  const rawServers = useServerStore((s) => s.servers);
  const servers = Array.isArray(rawServers) ? rawServers : [];
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const rawChannels = useServerStore((s) => s.channels);
  const channels = Array.isArray(rawChannels) ? rawChannels : [];
  const selectedChannelId = useServerStore((s) => s.selectedChannelId);
  const selectServer = useServerStore((s) => s.selectServer);
  const selectChannel = useServerStore((s) => s.selectChannel);
  const isLoadingChannels = useServerStore((s) => s.isLoadingChannels);
  const user = useAuthStore((s) => s.user);

  const rawDMs = useDMStore((s) => s.dmChannels);
  const dmChannels = Array.isArray(rawDMs) ? rawDMs : [];
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const selectDM = useDMStore((s) => s.selectDM);
  const closeDM = useDMStore((s) => s.closeDM);
  const fetchDMs = useDMStore((s) => s.fetchDMs);

  const unreadChannels = useUnreadStore((s) => s.unreadChannels);
  const permissionMap = usePermissionStore((s) => s.permissions);

  const [expandedServerId, setExpandedServerId] = useState<string | null>(selectedServerId);
  const [dmExpanded, setDmExpanded] = useState(true);
  const [dmShowAll, setDmShowAll] = useState(false);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [inviteServerId, setInviteServerId] = useState<string | null>(null);
  const [settingsServerId, setSettingsServerId] = useState<string | null>(null);
  const [newDMOpen, setNewDMOpen] = useState(false);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showCreateCategory, setShowCreateCategory] = useState<string | null>(null); // serverId or null
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [createChannelInCategory, setCreateChannelInCategory] = useState<string | null>(null);
  const [newChannelName, setNewChannelName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [isDeletingCategory, setIsDeletingCategory] = useState(false);
  const editCategoryRef = useRef<HTMLInputElement>(null);
  // See ChannelList: restore focus to the deleting category's persistent context-menu
  // trigger (the shared dialog captures the menu portal, which unmounts on close).
  const categoryTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingReturnFocusRef = useRef<HTMLElement | null>(null);

  // Fetch DMs on mount
  useEffect(() => { fetchDMs(); }, [fetchDMs]);

  // Sync expandedServerId with selectedServerId on external changes
  useEffect(() => {
    if (selectedServerId) {
      setExpandedServerId(selectedServerId);
    }
  }, [selectedServerId]);

  const categoriesSeqRef = useRef(0);
  const fetchCategories = useCallback(() => {
    if (!expandedServerId) {
      // Empty scope (collapsed) invalidates outstanding reads too.
      categoriesSeqRef.current += 1;
      return;
    }
    // Owned by session AND recency: a fetch settling after an identity boundary
    // must not populate the new session's sidebar, and an OLDER fetch settling
    // after a newer one must not overwrite its categories.
    const generation = captureSessionGeneration();
    const seq = ++categoriesSeqRef.current;
    apiGetCategories(expandedServerId).then((cats) => {
      if (seq !== categoriesSeqRef.current || !isSessionGenerationCurrent(generation)) return;
      const safeCats = Array.isArray(cats) ? cats : [];
      setCategories(safeCats.sort((a, b) => a.position - b.position));
    }).catch(() => {});
  }, [expandedServerId]);

  // Track the current expanded server for scope checks in mutation continuations.
  // Updated DURING RENDER (latest-prop mirror) -- a passive effect leaves a
  // post-render/pre-effect stale window.
  const expandedServerIdRef = useRef(expandedServerId);
  expandedServerIdRef.current = expandedServerId;

  // Fetch categories when expanded server changes -- clearing FIRST, so server A's
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

  // Focus category edit input
  useEffect(() => {
    if (editingCategoryId && editCategoryRef.current) {
      editCategoryRef.current.focus();
      editCategoryRef.current.select();
    }
  }, [editingCategoryId]);

  const handleCreateCategory = async (e: FormEvent, serverId: string) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    // Owned by session AND server scope: a continuation settling after the
    // expanded server changed must not refetch the OLD server under the new one.
    const generation = captureSessionGeneration();
    try {
      await apiCreateCategory(serverId, trimmed);
      if (!isSessionGenerationCurrent(generation)) return;
      if (expandedServerIdRef.current !== serverId) return;
      setNewCategoryName('');
      setShowCreateCategory(null);
      fetchCategories();
    } catch { /* silently fail */ }
  };

  const handleRenameCategory = async (catId: string) => {
    const trimmed = editCategoryName.trim();
    if (!trimmed || !expandedServerId) {
      setEditingCategoryId(null);
      return;
    }
    const cat = categories.find((c) => c.id === catId);
    if (cat && trimmed === cat.name) {
      setEditingCategoryId(null);
      return;
    }
    const generation = captureSessionGeneration();
    const serverIdAtStart = expandedServerId;
    const stillOurs = () => isSessionGenerationCurrent(generation)
      && expandedServerIdRef.current === serverIdAtStart;
    try {
      await apiUpdateCategory(expandedServerId, catId, { name: trimmed });
      if (stillOurs()) fetchCategories();
    } catch { /* silently fail */ }
    if (stillOurs()) setEditingCategoryId(null);
  };

  const handleDeleteCategory = async () => {
    if (!deletingCategoryId || !expandedServerId) return;
    setIsDeletingCategory(true); // locks the dialog so it can't be dismissed mid-request
    const generation = captureSessionGeneration();
    const serverIdAtStart = expandedServerId;
    const stillOurs = () => isSessionGenerationCurrent(generation)
      && expandedServerIdRef.current === serverIdAtStart;
    try {
      await apiDeleteCategory(expandedServerId, deletingCategoryId);
      // A stale delete completing must not refetch into -- or reselect within --
      // the NEW session or a DIFFERENT server scope.
      if (stillOurs()) {
        fetchCategories();
        useServerStore.getState().selectServer(expandedServerId);
      }
    } catch { /* silently fail */ }
    if (stillOurs()) {
      setIsDeletingCategory(false);
      setDeletingCategoryId(null);
    }
  };

  const handleEditCategoryKeyDown = (e: KeyboardEvent<HTMLInputElement>, catId: string) => {
    if (e.key === 'Enter') { e.preventDefault(); handleRenameCategory(catId); }
    if (e.key === 'Escape') { setEditingCategoryId(null); }
  };

  const handleCreateChannelInSidebar = async (e: FormEvent, serverId: string) => {
    e.preventDefault();
    const trimmed = newChannelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed) return;
    // Workflow-owned: this writes the channel list straight into the shared store,
    // so a boundary during either await must stop it from overwriting the NEW
    // session's channels with the old server's list.
    const generation = captureSessionGeneration();
    try {
      await apiCreateChannel(serverId, trimmed, undefined, createChannelInCategory || undefined);
      if (!isSessionGenerationCurrent(generation)) return;
      // Owned read-after-write refresh: the store action claims the lineage at
      // start and commits only while it still owns it and the server is still
      // selected -- a realtime commit mid-refresh supersedes it.
      await useServerStore.getState().refreshChannels(serverId);
      if (!isSessionGenerationCurrent(generation)) return;
      setNewChannelName('');
      setShowCreateChannel(false);
      setCreateChannelInCategory(null);
    } catch { /* silently fail */ }
  };

  const startCreateInCategory = (_serverId: string, categoryId: string | null) => {
    setCreateChannelInCategory(categoryId);
    setNewChannelName('');
    setShowCreateChannel(true);
    if (categoryId) {
      setCollapsedCategories((prev) => {
        const next = new Set(prev);
        next.delete(categoryId);
        return next;
      });
    }
  };

  const handleExpandServer = useCallback((serverId: string) => {
    if (expandedServerId === serverId) {
      setExpandedServerId(null);
      return;
    }
    setExpandedServerId(serverId);
    selectDM(null);
    selectServer(serverId);
  }, [expandedServerId, selectDM, selectServer]);

  const handleSelectDM = useCallback((channelId: string) => {
    selectDM(channelId);
    // Claim the channel lineage: a held selectServer settling after we entered DM
    // scope must not select a server channel that would shadow this DM.
    useServerStore.getState().clearServerSelection();
  }, [selectDM]);

  const handleSelectChannel = useCallback((channelId: string) => {
    selectChannel(channelId);
    selectDM(null);
  }, [selectChannel, selectDM]);

  const toggleCategory = (catId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const visibleDMs = dmShowAll ? dmChannels : dmChannels.slice(0, DM_VISIBLE_COUNT);

  return (
    <div className="flex h-full w-[280px] flex-col bg-[var(--bg-secondary)]">
      {/* Brand header */}
      <div className="flex h-12 shrink-0 items-center border-b border-[var(--border)] px-4 safe-area-top">
        <img src={bastionLogo} alt="Bastion" className="mr-2.5 h-6 w-6" />
        <h1 className="text-sm font-bold text-[var(--text-primary)]">Bastion</h1>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* ---- DM Section ---- */}
        <div className="border-b border-[var(--border)]">
          <div className="flex items-center justify-between px-3 py-2">
            <button
              onClick={() => setDmExpanded(!dmExpanded)}
              className="flex items-center gap-1"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
                className={`shrink-0 text-[var(--text-muted)] transition-transform ${dmExpanded ? '' : '-rotate-90'}`}
              >
                <path d="M7 10l5 5 5-5z" />
              </svg>
              <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                Direct Messages
              </span>
            </button>
            <button
              onClick={() => setNewDMOpen(true)}
              className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              title="New DM"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
              </svg>
            </button>
          </div>

          {dmExpanded && (
            <div className="px-2 pb-2">
              {visibleDMs.length === 0 ? (
                <p className="px-2 py-2 text-center text-xs text-[var(--text-muted)]">
                  No conversations yet.
                </p>
              ) : (
                <div className="space-y-0.5">
                  {visibleDMs.map((dm) => {
                    const recipient = dm.recipients?.[0];
                    const name = recipient
                      ? recipient.displayName || recipient.username
                      : 'Unknown';
                    const initial = name.charAt(0).toUpperCase();
                    const isSelected = dm.id === selectedDMId && !selectedChannelId;
                    const hasUnread = unreadChannels.has(dm.id);

                    return (
                      <div
                        key={dm.id}
                        className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]'
                        }`}
                        onClick={() => handleSelectDM(dm.id)}
                      >
                        <div className="relative shrink-0">
                          {recipient?.avatarUrl ? (
                            <img
                              src={resolveMediaUrl(recipient.avatarUrl)}
                              alt={name}
                              className="h-7 w-7 rounded-full object-cover"
                            />
                          ) : (
                            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-semibold text-white">
                              {initial}
                            </div>
                          )}
                          {recipient && (
                            <PresenceDot
                              userId={recipient.id}
                              className="absolute -bottom-0.5 -right-0.5 !h-3 !w-3 !border"
                            />
                          )}
                        </div>
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${
                            hasUnread
                              ? 'font-bold text-[var(--text-primary)]'
                              : 'font-medium'
                          }`}
                        >
                          {name}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            closeDM(dm.id);
                          }}
                          className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover:opacity-100"
                          title="Close DM"
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {!dmShowAll && dmChannels.length > DM_VISIBLE_COUNT && (
                <button
                  onClick={() => setDmShowAll(true)}
                  className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                >
                  Show all ({dmChannels.length})
                </button>
              )}
              {dmShowAll && dmChannels.length > DM_VISIBLE_COUNT && (
                <button
                  onClick={() => setDmShowAll(false)}
                  className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                >
                  Show less
                </button>
              )}
            </div>
          )}
        </div>

        {/* ---- Server Sections ---- */}
        {servers.map((server) => {
          const isExpanded = expandedServerId === server.id;
          const isOwner = user && server.ownerId === user.id;
          const serverPerms = permissionMap[server.id] ?? 0;
          const canManageServer = !!isOwner || (serverPerms & PERMISSIONS.ManageServer) === PERMISSIONS.ManageServer;
          const canManageChannels = !!isOwner || (serverPerms & PERMISSIONS.ManageChannels) === PERMISSIONS.ManageChannels;

          // Unread indicator for collapsed servers: check if any known channel has unreads
          // When expanded, channels are in the store; when collapsed, we can't check reliably
          // so we rely on the unreadChannels set (channel IDs persist across server switches)
          const serverHasUnread = !isExpanded && channels.length === 0
            ? false // Can't determine — TODO: backend server-level unread tracking
            : isExpanded
              ? channels.some((c) => unreadChannels.has(c.id))
              : false;

          return (
            <div key={server.id} className="border-b border-[var(--border)]">
              {/* Server header */}
              <div className="flex items-center">
                <button
                  onClick={() => handleExpandServer(server.id)}
                  className="flex min-w-0 flex-1 items-center gap-1 px-3 py-2 text-left"
                >
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className={`shrink-0 text-[var(--text-muted)] transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                  >
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                  {server.iconUrl ? (
                    <img
                      src={resolveMediaUrl(server.iconUrl)}
                      alt={server.name}
                      className="h-5 w-5 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
                      style={{ backgroundColor: getColorForId(server.id) }}
                    >
                      {server.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="text-[var(--text-muted)]">-</span>
                  <span
                    className={`min-w-0 flex-1 truncate text-sm font-semibold ${
                      serverHasUnread
                        ? 'text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    {server.name}
                  </span>
                  {!isExpanded && serverHasUnread && (
                    <div className="h-2 w-2 shrink-0 rounded-full bg-white" />
                  )}
                </button>

                {isExpanded && (
                  <div className="flex shrink-0 gap-0.5 pr-2">
                    <button
                      onClick={() => setInviteServerId(server.id)}
                      className="rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                      title="Invite People"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                        <circle cx="8.5" cy="7" r="4" />
                        <line x1="20" y1="8" x2="20" y2="14" />
                        <line x1="23" y1="11" x2="17" y2="11" />
                      </svg>
                    </button>
                    {canManageServer && (
                      <button
                        onClick={() => setSettingsServerId(server.id)}
                        className="rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                        title="Server Settings"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Channels (when expanded) */}
              {isExpanded && (
                <div className="px-2 pb-2">
                  {isLoadingChannels ? (
                    <div className="flex items-center justify-center py-4">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
                    </div>
                  ) : channels.length === 0 && categories.length === 0 ? (
                    <div>
                      <p className="px-2 py-2 text-center text-xs text-[var(--text-muted)]">
                        No channels yet.
                      </p>
                      {canManageChannels && (
                        <div className="flex flex-col gap-1 px-1">
                          <button
                            onClick={() => startCreateInCategory(server.id, null)}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" /></svg>
                            Create Channel
                          </button>
                          <button
                            onClick={() => { setShowCreateCategory(server.id); setNewCategoryName(''); }}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                              <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
                            </svg>
                            Create Category
                          </button>
                        </div>
                      )}
                      {showCreateCategory === server.id && (
                        <form onSubmit={(e) => handleCreateCategory(e, server.id)} className="px-1 mt-1">
                          <input type="text" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} placeholder="Category name" autoFocus
                            className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                            onBlur={() => { if (!newCategoryName.trim()) setShowCreateCategory(null); }}
                            onKeyDown={(e) => { if (e.key === 'Escape') { setNewCategoryName(''); setShowCreateCategory(null); } }}
                          />
                        </form>
                      )}
                      {showCreateChannel && (
                        <form onSubmit={(e) => handleCreateChannelInSidebar(e, server.id)} className="px-1 mt-1">
                          <input type="text" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} placeholder="new-channel" autoFocus
                            className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                            onBlur={() => { if (!newChannelName.trim()) { setShowCreateChannel(false); setCreateChannelInCategory(null); } }}
                            onKeyDown={(e) => { if (e.key === 'Escape') { setNewChannelName(''); setShowCreateChannel(false); setCreateChannelInCategory(null); } }}
                          />
                        </form>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Uncategorized channels */}
                      {(() => {
                        const uncategorized = channels.filter((c) => !c.categoryId);
                        if (uncategorized.length === 0 && categories.length > 0 && !showCreateChannel) return null;
                        return (
                          <div className="mb-1">
                            <div className="mb-0.5 flex items-center justify-between px-1">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                                Text Channels
                              </span>
                              {canManageChannels && (
                                <div className="flex gap-0.5">
                                  <button
                                    onClick={() => { setShowCreateCategory(server.id); setNewCategoryName(''); }}
                                    className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                                    title="Create Category"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                      <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => startCreateInCategory(server.id, null)}
                                    className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                                    title="Create Channel"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" /></svg>
                                  </button>
                                </div>
                              )}
                            </div>
                            {showCreateCategory === server.id && (
                              <form onSubmit={(e) => handleCreateCategory(e, server.id)} className="mb-1 px-1">
                                <input type="text" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} placeholder="Category name" autoFocus
                                  className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                  onBlur={() => { if (!newCategoryName.trim()) setShowCreateCategory(null); }}
                                  onKeyDown={(e) => { if (e.key === 'Escape') { setNewCategoryName(''); setShowCreateCategory(null); } }}
                                />
                              </form>
                            )}
                            {showCreateChannel && createChannelInCategory === null && (
                              <form onSubmit={(e) => handleCreateChannelInSidebar(e, server.id)} className="mb-1 px-1">
                                <input type="text" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} placeholder="new-channel" autoFocus
                                  className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                  onBlur={() => { if (!newChannelName.trim()) { setShowCreateChannel(false); setCreateChannelInCategory(null); } }}
                                  onKeyDown={(e) => { if (e.key === 'Escape') { setNewChannelName(''); setShowCreateChannel(false); setCreateChannelInCategory(null); } }}
                                />
                              </form>
                            )}
                            <div className="space-y-0.5">
                              {uncategorized.map((channel) => (
                                <ChannelItem
                                  key={channel.id}
                                  channel={channel}
                                  isSelected={channel.id === selectedChannelId && !selectedDMId}
                                  onClick={() => handleSelectChannel(channel.id)}
                                  canManage={canManageChannels}
                                  serverId={server.id}
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
                          <div key={cat.id} className="mb-1">
                            <div className="mb-0.5 flex items-center justify-between px-1">
                              {isEditingThis ? (
                                <input
                                  ref={editCategoryRef}
                                  type="text"
                                  value={editCategoryName}
                                  onChange={(e) => setEditCategoryName(e.target.value)}
                                  onKeyDown={(e) => handleEditCategoryKeyDown(e, cat.id)}
                                  onBlur={() => handleRenameCategory(cat.id)}
                                  className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                />
                              ) : (
                                <ContextMenu.Root>
                                  <ContextMenu.Trigger asChild>
                                    <button
                                      ref={(el) => {
                                        categoryTriggerRefs.current[cat.id] = el;
                                      }}
                                      onClick={() => toggleCategory(cat.id)}
                                      className="flex min-w-0 flex-1 items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                                    >
                                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>
                                        <path d="M7 10l5 5 5-5z" />
                                      </svg>
                                      <span className="truncate">{cat.name}</span>
                                    </button>
                                  </ContextMenu.Trigger>
                                  {canManageChannels && (
                                    <ContextMenu.Portal>
                                      <ContextMenu.Content className="z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-xl">
                                        <ContextMenu.Item
                                          onSelect={() => { setEditCategoryName(cat.name); setEditingCategoryId(cat.id); }}
                                          className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
                                        >
                                          Edit Category
                                        </ContextMenu.Item>
                                        <ContextMenu.Item
                                          onSelect={() => startCreateInCategory(server.id, cat.id)}
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
                                  onClick={() => startCreateInCategory(server.id, cat.id)}
                                  className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                                  title="Create Channel"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" /></svg>
                                </button>
                              )}
                            </div>
                            {!isCollapsed && (
                              <>
                                {showCreateChannel && createChannelInCategory === cat.id && (
                                  <form onSubmit={(e) => handleCreateChannelInSidebar(e, server.id)} className="mb-1 px-1">
                                    <input type="text" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} placeholder="new-channel" autoFocus
                                      className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                      onBlur={() => { if (!newChannelName.trim()) { setShowCreateChannel(false); setCreateChannelInCategory(null); } }}
                                      onKeyDown={(e) => { if (e.key === 'Escape') { setNewChannelName(''); setShowCreateChannel(false); setCreateChannelInCategory(null); } }}
                                    />
                                  </form>
                                )}
                                <div className="space-y-0.5">
                                  {catChannels.map((channel) => (
                                    <ChannelItem
                                      key={channel.id}
                                      channel={channel}
                                      isSelected={channel.id === selectedChannelId && !selectedDMId}
                                      onClick={() => handleSelectChannel(channel.id)}
                                      canManage={canManageChannels}
                                      serverId={server.id}
                                      categories={categories}
                                    />
                                  ))}
                                </div>
                                {catChannels.length === 0 && !showCreateChannel && (
                                  <p className="px-3 py-1 text-xs text-[var(--text-muted)]">No channels</p>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Add Server button */}
        <div className="px-3 py-2">
          <button
            onClick={() => setCreateServerOpen(true)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
            </svg>
            Add Server
          </button>
        </div>
      </div>

      {/* User panel */}
      <UserPanel />

      {/* Dialogs */}
      <CreateServerDialog
        open={createServerOpen}
        onOpenChange={setCreateServerOpen}
      />
      <NewDMDialog open={newDMOpen} onOpenChange={setNewDMOpen} />
      {inviteServerId && (
        <InviteDialog
          open={!!inviteServerId}
          onOpenChange={(open) => {
            if (!open) setInviteServerId(null);
          }}
          serverId={inviteServerId}
        />
      )}
      {settingsServerId && (
        <ServerSettingsDialog
          open={!!settingsServerId}
          onOpenChange={(open) => {
            if (!open) setSettingsServerId(null);
          }}
          serverId={settingsServerId}
        />
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
