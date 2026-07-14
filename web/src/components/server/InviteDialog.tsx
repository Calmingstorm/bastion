import { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiCreateInvite, apiGetInvites, apiDeleteInvite } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { getPlatform } from '../../platform';
import type { ServerInvite } from '../../types';

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
}

export function InviteDialog({ open, onOpenChange, serverId }: InviteDialogProps) {
  const [invites, setInvites] = useState<ServerInvite[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Only the LATEST list fetch owns the list (session + recency): a held
  // old-session response must not populate this still-mounted dialog late.
  const listFetchSeqRef = useRef(0);

  useEffect(() => {
    if (open && serverId) {
      const generation = captureSessionGeneration();
      const seq = ++listFetchSeqRef.current;
      apiGetInvites(serverId)
        .then((fetched) => {
          if (seq === listFetchSeqRef.current && isSessionGenerationCurrent(generation)) {
            setInvites(fetched);
          }
        })
        .catch(() => {});
    }
  }, [open, serverId]);

  const handleCreate = async () => {
    setIsCreating(true);
    // A create resolving after an identity boundary belongs to the previous
    // session -- do not surface its invite link in the new session's UI.
    const generation = captureSessionGeneration();
    try {
      const invite = await apiCreateInvite(serverId, { expiresIn: 86400 * 7 }); // 7 days
      if (!isSessionGenerationCurrent(generation)) return;
      setInvites((prev) => [invite, ...prev]);
    } catch {
      // Error handling
    } finally {
      if (isSessionGenerationCurrent(generation)) setIsCreating(false);
    }
  };

  const handleDelete = async (inviteId: string) => {
    const generation = captureSessionGeneration();
    try {
      await apiDeleteInvite(inviteId);
      if (!isSessionGenerationCurrent(generation)) return;
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch {
      // Error handling
    }
  };

  const handleCopy = (code: string) => {
    const origin = getPlatform().getOrigin();
    const link = `${origin}/invite/${code}`;
    navigator.clipboard.writeText(link);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
          <Dialog.Title className="text-xl font-bold text-[var(--text-primary)]">
            Server Invites
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--text-secondary)]">
            Share these links with friends to invite them.
          </Dialog.Description>

          <div className="mt-4">
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="rounded-[3px] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {isCreating ? 'Creating...' : 'Create Invite Link'}
            </button>
          </div>

          <div className="mt-4 max-h-60 space-y-2 overflow-y-auto">
            {invites.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">
                No active invites. Create one above.
              </p>
            )}
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between rounded bg-[var(--bg-secondary)] p-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm text-[var(--text-primary)]">
                    {invite.code}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {invite.uses} uses
                    {invite.maxUses ? ` / ${invite.maxUses} max` : ''}
                    {invite.expiresAt && ` — expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleCopy(invite.code)}
                    className="rounded px-3 py-1 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10"
                  >
                    {copied === invite.code ? 'Copied!' : 'Copy Link'}
                  </button>
                  <button
                    onClick={() => handleDelete(invite.id)}
                    className="rounded px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--danger)]"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <button className="rounded-[3px] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
