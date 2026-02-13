import { useState, useEffect } from 'react';
import { useDMStore } from '../../stores/dmStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { resolveMediaUrl } from '../../platform';
import { PresenceDot } from '../user/PresenceDot';
import { UserPanel } from '../user/UserPanel';
import { NewDMDialog } from './NewDMDialog';

export function DMList() {
  // Targeted selectors to avoid cascading re-renders
  const dmChannels = useDMStore((s) => s.dmChannels);
  const selectedDMId = useDMStore((s) => s.selectedDMId);
  const selectDM = useDMStore((s) => s.selectDM);
  const closeDM = useDMStore((s) => s.closeDM);
  const fetchDMs = useDMStore((s) => s.fetchDMs);
  const unreadChannels = useUnreadStore((s) => s.unreadChannels);
  const [newDMOpen, setNewDMOpen] = useState(false);

  useEffect(() => {
    fetchDMs();
  }, [fetchDMs]);

  const handleSelect = (channelId: string) => {
    selectDM(channelId);
  };

  return (
    <div className="flex h-full w-60 flex-col bg-[var(--bg-secondary)]">
      <div className="flex h-12 items-center justify-between border-b border-[var(--border)] px-4">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          Direct Messages
        </span>
        <button
          onClick={() => setNewDMOpen(true)}
          className="rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          title="New DM"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {dmChannels.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-[var(--text-muted)]">
            No conversations yet.
          </p>
        ) : (
          <div className="space-y-0.5">
            {dmChannels.map((dm) => {
              const recipient = dm.recipients?.[0];
              const name = recipient
                ? recipient.displayName || recipient.username
                : 'Unknown';
              const initial = name.charAt(0).toUpperCase();
              const isSelected = dm.id === selectedDMId;
              const hasUnread = unreadChannels.has(dm.id);

              return (
                <div
                  key={dm.id}
                  className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]'
                  }`}
                  onClick={() => handleSelect(dm.id)}
                >
                  <div className="relative shrink-0">
                    {recipient?.avatarUrl ? (
                      <img
                        src={resolveMediaUrl(recipient.avatarUrl)}
                        alt={name}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
                        {initial}
                      </div>
                    )}
                    {recipient && (
                      <PresenceDot
                        userId={recipient.id}
                        className="absolute -bottom-0.5 -right-0.5"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm ${hasUnread ? 'font-bold text-[var(--text-primary)]' : 'font-medium'}`}>
                      {name}
                    </p>
                    {dm.lastMessage && (
                      <p className="truncate text-xs text-[var(--text-muted)]">
                        {dm.lastMessage.content}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDM(dm.id);
                    }}
                    className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] group-hover:opacity-100"
                    title="Close DM"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* User panel */}
      <UserPanel />

      <NewDMDialog open={newDMOpen} onOpenChange={setNewDMOpen} />
    </div>
  );
}
