import { useEffect } from 'react';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { PresenceDot } from '../user/PresenceDot';

export function DMList() {
  const { dmChannels, selectedDMId, selectDM, fetchDMs } = useDMStore();
  const { selectChannel } = useServerStore();
  const isUnread = useUnreadStore((s) => s.isUnread);

  useEffect(() => {
    fetchDMs();
  }, [fetchDMs]);

  const handleSelect = (channelId: string) => {
    selectDM(channelId);
    // Also set as selected channel for message display
    selectChannel(channelId);
  };

  return (
    <div className="flex h-full w-60 flex-col bg-[var(--bg-secondary)]">
      <div className="flex h-12 items-center border-b border-[var(--border)] px-4">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          Direct Messages
        </span>
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
              const hasUnread = isUnread(dm.id);

              return (
                <button
                  key={dm.id}
                  onClick={() => handleSelect(dm.id)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <div className="relative shrink-0">
                    {recipient?.avatarUrl ? (
                      <img
                        src={recipient.avatarUrl}
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
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
