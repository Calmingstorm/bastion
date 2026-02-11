import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiGetPinnedMessages, apiUnpinMessage } from '../../api/client';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { PinnedMessage } from '../../types';
import { eventBus } from '../../utils/eventBus';

interface PinnedMessagesProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
}

export function PinnedMessages({ open, onOpenChange, channelId }: PinnedMessagesProps) {
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!open || !channelId) return;
    setIsLoading(true);
    apiGetPinnedMessages(channelId)
      .then(setPins)
      .catch(() => setPins([]))
      .finally(() => setIsLoading(false));
  }, [open, channelId]);

  // Listen for pin updates
  useEffect(() => {
    const handler = () => {
      if (open && channelId) {
        apiGetPinnedMessages(channelId).then(setPins).catch(() => {});
      }
    };
    eventBus.on('bastion:pin-update', handler);
    return () => eventBus.off('bastion:pin-update', handler);
  }, [open, channelId]);

  const handleUnpin = async (messageId: string) => {
    try {
      await apiUnpinMessage(channelId, messageId);
      setPins((prev) => prev.filter((p) => p.id !== messageId));
    } catch { /* handled */ }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--border)] p-4">
            <Dialog.Title className="text-lg font-bold text-[var(--text-primary)]">
              Pinned Messages
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
              </div>
            ) : pins.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-muted)]">
                No pinned messages in this channel.
              </p>
            ) : (
              <div className="space-y-3">
                {pins.map((pin) => {
                  const displayName = pin.author?.displayName || pin.author?.username || 'Unknown';
                  const initial = displayName.charAt(0).toUpperCase();
                  return (
                    <div key={pin.id} className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                      <div className="flex items-center gap-2">
                        {pin.author?.avatarUrl ? (
                          <img src={pin.author.avatarUrl} alt={displayName} className="h-6 w-6 rounded-full object-cover" />
                        ) : (
                          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">{initial}</div>
                        )}
                        <span className="text-sm font-medium text-[var(--text-primary)]">{displayName}</span>
                        <span className="text-xs text-[var(--text-muted)]">
                          {new Date(pin.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="mt-2 text-sm text-[var(--text-secondary)]">
                        <MarkdownRenderer content={pin.content} />
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[10px] text-[var(--text-muted)]">
                          Pinned {new Date(pin.pinnedAt).toLocaleDateString()}
                        </span>
                        <button
                          onClick={() => handleUnpin(pin.id)}
                          className="rounded px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                        >
                          Unpin
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
