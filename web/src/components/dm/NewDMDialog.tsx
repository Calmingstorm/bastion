import { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiSearchUsers, apiCreateDM } from '../../api/client';
import { useDMStore } from '../../stores/dmStore';
import { resolveMediaUrl } from '../../platform';
import type { MessageAuthor } from '../../types';

interface NewDMDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewDMDialog({ open, onOpenChange }: NewDMDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageAuthor[]>([]);
  const [selected, setSelected] = useState<MessageAuthor[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selectDM = useDMStore((s) => s.selectDM);
  const fetchDMs = useDMStore((s) => s.fetchDMs);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelected([]);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const users = await apiSearchUsers(query.trim());
        // Filter out already selected users
        const selectedIds = new Set(selected.map((u) => u.id));
        setResults(users.filter((u) => !selectedIds.has(u.id)));
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, selected]);

  const handleSelect = (user: MessageAuthor) => {
    if (selected.length >= 9) return;
    setSelected((prev) => [...prev, user]);
    setQuery('');
    setResults([]);
    inputRef.current?.focus();
  };

  const handleRemove = (userId: string) => {
    setSelected((prev) => prev.filter((u) => u.id !== userId));
  };

  const handleCreate = async () => {
    if (selected.length === 0) return;
    setIsCreating(true);
    setError(null);
    try {
      const dm = await apiCreateDM(selected.map((u) => u.id));
      await fetchDMs();
      selectDM(dm.id);
      onOpenChange(false);
    } catch {
      setError('Failed to create conversation.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
          <Dialog.Title className="text-lg font-bold text-[var(--text-primary)]">
            New Direct Message
          </Dialog.Title>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Search for users to start a conversation.
          </p>

          {/* Selected users chips */}
          {selected.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {selected.map((user) => (
                <span key={user.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/20 px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
                  {user.displayName || user.username}
                  <button onClick={() => handleRemove(user.id)} className="ml-0.5 text-[var(--accent)] hover:text-[var(--text-primary)]">
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Search input */}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by username..."
            className="mt-3 w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />

          {/* Search results */}
          {(results.length > 0 || isSearching) && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-secondary)]">
              {isSearching ? (
                <p className="px-3 py-2 text-xs text-[var(--text-muted)]">Searching...</p>
              ) : (
                results.map((user) => {
                  const name = user.displayName || user.username;
                  const initial = name.charAt(0).toUpperCase();
                  return (
                    <button
                      key={user.id}
                      onClick={() => handleSelect(user)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-input)]"
                    >
                      {user.avatarUrl ? (
                        <img src={resolveMediaUrl(user.avatarUrl)} alt={name} className="h-6 w-6 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">{initial}</div>
                      )}
                      <span className="text-sm text-[var(--text-primary)]">{name}</span>
                      <span className="text-xs text-[var(--text-muted)]">@{user.username}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}

          {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}

          <div className="mt-4 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={handleCreate}
              disabled={isCreating || selected.length === 0}
              className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              {isCreating ? 'Creating...' : `Create DM${selected.length > 1 ? ' Group' : ''}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
