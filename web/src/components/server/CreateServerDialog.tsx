import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useServerStore } from '../../stores/serverStore';
import { apiJoinViaInvite } from '../../api/client';
import {
  captureSessionGeneration,
  isSessionGenerationCurrent,
  SessionSupersededError,
} from '../../api/session';

interface CreateServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateServerDialog({
  open,
  onOpenChange,
}: CreateServerDialogProps) {
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { createServer, selectServer, fetchServers, addServer } = useServerStore();

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Server name is required.');
      return;
    }

    if (trimmedName.length < 2) {
      setError('Server name must be at least 2 characters.');
      return;
    }

    setIsSubmitting(true);
    // The workflow is owned by the session it started under: a create settling
    // after an identity boundary must not close/clear this dialog as a success.
    const generation = captureSessionGeneration();
    try {
      await createServer(trimmedName);
      if (!isSessionGenerationCurrent(generation)) return;
      setName('');
      onOpenChange(false);
    } catch (err: unknown) {
      // Superseded: neither a success (do not close) nor an error to show.
      if (err instanceof SessionSupersededError) return;
      if (!isSessionGenerationCurrent(generation)) return;
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to create server.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    // Extract code from URL or use as-is
    let code = inviteCode.trim();
    const match = code.match(/\/invite\/([A-Za-z0-9]+)$/);
    if (match) {
      code = match[1];
    }

    if (!code) {
      setError('Invite code or link is required.');
      return;
    }

    setIsSubmitting(true);
    // Workflow-owned join: the joined server's id is only meaningful in the session
    // that initiated the join. A boundary during any await must stop the rest --
    // otherwise the new session's fetch/selection runs with the old workflow's id.
    const generation = captureSessionGeneration();
    try {
      const server = await apiJoinViaInvite(code);
      if (!isSessionGenerationCurrent(generation)) return;
      // The join response asserts the server's existence: commit it BEFORE the
      // list fetch so a tombstone from an earlier leave/kick/ban is cleared and
      // the rejoined server is visible immediately (same as InvitePage).
      addServer(server);
      await fetchServers();
      if (!isSessionGenerationCurrent(generation)) return;
      await selectServer(server.id);
      if (!isSessionGenerationCurrent(generation)) return;
      setInviteCode('');
      onOpenChange(false);
    } catch (err: unknown) {
      if (!isSessionGenerationCurrent(generation)) return;
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to join server.');
      } else {
        setError('Failed to join server.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName('');
      setInviteCode('');
      setError(null);
      setTab('create');
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
          <Dialog.Title className="text-xl font-bold text-[var(--text-primary)]">
            Add a Server
          </Dialog.Title>

          {/* Tab switcher */}
          <div className="mt-4 flex gap-2 rounded-md bg-[var(--bg-tertiary)] p-1">
            <button
              onClick={() => { setTab('create'); setError(null); }}
              className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === 'create'
                  ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Create
            </button>
            <button
              onClick={() => { setTab('join'); setError(null); }}
              className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === 'join'
                  ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              Join via Invite
            </button>
          </div>

          {tab === 'create' ? (
            <form onSubmit={handleCreate} className="mt-5 space-y-4">
              <Dialog.Description className="text-sm text-[var(--text-secondary)]">
                Your server is where you and your friends hang out.
              </Dialog.Description>

              {error && (
                <div className="rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
                  {error}
                </div>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="serverName"
                  className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"
                >
                  Server Name
                </label>
                <input
                  id="serverName"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="w-full rounded-[3px] border-none bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  placeholder="Enter server name"
                />
              </div>

              <div className="flex justify-end gap-3">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:underline"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleJoin} className="mt-5 space-y-4">
              <Dialog.Description className="text-sm text-[var(--text-secondary)]">
                Enter an invite link or code to join an existing server.
              </Dialog.Description>

              {error && (
                <div className="rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
                  {error}
                </div>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="inviteCode"
                  className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"
                >
                  Invite Link or Code
                </label>
                <input
                  id="inviteCode"
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoFocus
                  className="w-full rounded-[3px] border-none bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  placeholder="https://example.com/invite/abc123"
                />
              </div>

              <div className="flex justify-end gap-3">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:underline"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? 'Joining...' : 'Join Server'}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
