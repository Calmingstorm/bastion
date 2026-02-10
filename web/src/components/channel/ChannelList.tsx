import { useState, type FormEvent } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { ChannelItem } from './ChannelItem';
import { InviteDialog } from '../server/InviteDialog';
import { UserSettingsDialog } from '../user/UserSettingsDialog';

export function ChannelList() {
  const {
    servers,
    selectedServerId,
    channels,
    selectedChannelId,
    selectChannel,
    createChannel,
    isLoadingChannels,
  } = useServerStore();
  const { user } = useAuthStore();

  const [showCreate, setShowCreate] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const selectedServer = servers.find((s) => s.id === selectedServerId);
  const isOwner = selectedServer && user && selectedServer.ownerId === user.id;

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
        <button
          onClick={() => setInviteOpen(true)}
          className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
          title="Invite People"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <line x1="20" y1="8" x2="20" y2="14" />
            <line x1="23" y1="11" x2="17" y2="11" />
          </svg>
        </button>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {/* Text Channels header */}
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
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
              </svg>
            </button>
          )}
        </div>

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
          <div className="space-y-0.5">
            {channels.map((channel) => (
              <ChannelItem
                key={channel.id}
                channel={channel}
                isSelected={channel.id === selectedChannelId}
                onClick={() => selectChannel(channel.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* User panel at bottom */}
      <UserPanel onSettingsClick={() => setSettingsOpen(true)} />

      {/* Dialogs */}
      {selectedServerId && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          serverId={selectedServerId}
        />
      )}
      <UserSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function UserPanel({ onSettingsClick }: { onSettingsClick: () => void }) {
  const { user, logout } = useAuthStore();

  if (!user) return null;

  const initial = (user.displayName || user.username).charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-tertiary)]/50 px-2 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt={user.username} className="h-8 w-8 rounded-full object-cover" />
        ) : (
          initial
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
          {user.displayName || user.username}
        </p>
        <p className="truncate text-[11px] text-[var(--text-muted)]">
          Online
        </p>
      </div>
      <button
        onClick={onSettingsClick}
        className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
        title="User Settings"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>
      <button
        onClick={logout}
        className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-secondary)]"
        title="Log out"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      </button>
    </div>
  );
}
