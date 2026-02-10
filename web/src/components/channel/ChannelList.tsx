import { useState, useEffect, type FormEvent } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { ChannelItem } from './ChannelItem';
import { InviteDialog } from '../server/InviteDialog';
import { ServerSettingsDialog } from '../server/ServerSettingsDialog';
import { UserPanel } from '../user/UserPanel';
import { apiGetCategories } from '../../api/client';
import type { ChannelCategory } from '../../types';

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
  const [newChannelName, setNewChannelName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const isOwner = selectedServer && user && selectedServer.ownerId === user.id;

  // Fetch categories when server changes
  useEffect(() => {
    if (!selectedServerId) return;
    apiGetCategories(selectedServerId).then((cats) => {
      setCategories(cats.sort((a, b) => a.position - b.position));
    }).catch(() => {});
  }, [selectedServerId]);

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
    try {
      await createChannel(selectedServerId, trimmed);
      setNewChannelName('');
      setShowCreate(false);
    } catch {
      // Error is handled in the store
    } finally {
      setIsCreating(false);
    }
  };

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
          {isOwner && (
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
        {/* Create channel inline form */}
        {showCreate && (
          <form onSubmit={handleCreateChannel} className="mb-2 px-1">
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
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setNewChannelName('');
                  setShowCreate(false);
                }
              }}
            />
          </form>
        )}

        {isLoadingChannels ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
          </div>
        ) : channels.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-[var(--text-muted)]">
            No channels yet.
            {isOwner && ' Click + to create one.'}
          </p>
        ) : (
          <>
            {/* Uncategorized channels */}
            {(() => {
              const uncategorized = channels.filter((c) => !c.categoryId);
              if (uncategorized.length === 0 && categories.length > 0) return null;
              return (
                <div className="mb-2">
                  <div className="mb-1 flex items-center justify-between px-1">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                      Text Channels
                    </span>
                    {isOwner && (
                      <button
                        onClick={() => setShowCreate(!showCreate)}
                        className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                        title="Create Channel"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {uncategorized.map((channel) => (
                      <ChannelItem
                        key={channel.id}
                        channel={channel}
                        isSelected={channel.id === selectedChannelId}
                        onClick={() => selectChannel(channel.id)}
                        canManage={!!isOwner}
                        serverId={selectedServerId || undefined}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Categorized channels */}
            {categories.map((cat) => {
              const catChannels = channels.filter((c) => c.categoryId === cat.id);
              if (catChannels.length === 0) return null;
              const isCollapsed = collapsedCategories.has(cat.id);
              return (
                <div key={cat.id} className="mb-2">
                  <button
                    onClick={() => toggleCategory(cat.id)}
                    className="mb-1 flex w-full items-center gap-1 px-1 text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
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
                    {cat.name}
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-0.5">
                      {catChannels.map((channel) => (
                        <ChannelItem
                          key={channel.id}
                          channel={channel}
                          isSelected={channel.id === selectedChannelId}
                          onClick={() => selectChannel(channel.id)}
                          canManage={!!isOwner}
                          serverId={selectedServerId || undefined}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
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
    </div>
  );
}
