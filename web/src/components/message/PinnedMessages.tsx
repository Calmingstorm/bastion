import { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiGetPinnedMessages, apiUnpinMessage } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { resolveMediaUrl } from '../../platform';
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
  // Track the current channel for scope checks in mutation continuations. Updated
  // DURING RENDER (the sanctioned latest-prop mirror), not in a passive effect --
  // an effect leaves a post-render/pre-effect window where a continuation would
  // compare against the stale value and wrongly commit.
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  // Only the LATEST fetch owns the pins and loading flag -- across session
  // boundaries AND channel switches (the effect refetches on channelId change,
  // claiming a new sequence, which supersedes reads and mutation continuations
  // started for the previous channel).
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    if (!open || !channelId) return;
    setIsLoading(true);
    const generation = captureSessionGeneration();
    const seq = ++fetchSeqRef.current;
    const owns = () => seq === fetchSeqRef.current && isSessionGenerationCurrent(generation);
    apiGetPinnedMessages(channelId)
      .then((p) => {
        if (owns()) setPins(p);
      })
      .catch(() => {
        if (owns()) setPins([]);
      })
      .finally(() => {
        if (owns()) setIsLoading(false);
      });
  }, [open, channelId]);

  // Listen for pin updates
  useEffect(() => {
    const handler = () => {
      if (open && channelId) {
        const generation = captureSessionGeneration();
        const seq = ++fetchSeqRef.current;
        const owns = () => seq === fetchSeqRef.current && isSessionGenerationCurrent(generation);
        apiGetPinnedMessages(channelId)
          .then((p) => {
            if (owns()) setPins(p);
          })
          .catch(() => {})
          .finally(() => {
            // This refresh may have superseded a held initial fetch (whose own
            // finally is then skipped) -- the owning fetch must clear loading, or
            // the spinner would hide the pins it just committed.
            if (owns()) setIsLoading(false);
          });
      }
    };
    eventBus.on('bastion:pin-update', handler);
    return () => eventBus.off('bastion:pin-update', handler);
  }, [open, channelId]);

  const handleUnpin = async (messageId: string) => {
    // Owned by the SESSION and the CHANNEL it was started for. It must NOT be
    // sequence-gated (the unpin's own WebSocket pin-update advances the shared
    // sequence, and if that refresh fails the filter here removes the pin) -- but
    // a completion from a PREVIOUS channel must commit nothing: advancing the
    // shared sequence then would discard the current channel's in-flight pins
    // response and strand its spinner.
    const generation = captureSessionGeneration();
    const channelAtStart = channelId;
    try {
      await apiUnpinMessage(channelId, messageId);
      if (!isSessionGenerationCurrent(generation)) return;
      if (channelIdRef.current !== channelAtStart) return;
      setPins((prev) => prev.filter((p) => p.id !== messageId));
      // The COMMITTED mutation supersedes every in-flight read that predates it:
      // an older (pre-unpin) refresh settling later must not resurrect the pin.
      fetchSeqRef.current += 1;
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
                          <img src={resolveMediaUrl(pin.author.avatarUrl)} alt={displayName} className="h-6 w-6 rounded-full object-cover" />
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
