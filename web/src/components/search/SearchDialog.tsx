import { useState, useEffect, useRef, useCallback } from 'react';
import { apiSearch } from '../../api/client';
import { useServerStore } from '../../stores/serverStore';
import type { SearchResult } from '../../types';

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return d.toLocaleDateString([], { weekday: 'long' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const selectChannel = useServerStore((s) => s.selectChannel);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const doSearch = useCallback((q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      apiSearch(q.trim(), { serverId: selectedServerId || undefined })
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 400);
  }, [selectedServerId]);

  const handleResultClick = (result: SearchResult) => {
    // Navigate to the channel
    if (selectedServerId) {
      selectChannel(result.channelId);
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative flex max-h-[75vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => doSearch(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
          />
          <kbd className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">ESC</kbd>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
            </div>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <div className="py-8 text-center text-sm text-[var(--text-muted)]">
              No results found
            </div>
          )}

          {!loading && results.map((result) => (
            <button
              key={result.id}
              onClick={() => handleResultClick(result)}
              className="flex w-full flex-col gap-1 border-b border-[var(--border)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span className="font-medium text-[var(--accent)]">#{result.channelName}</span>
                {result.serverName && (
                  <>
                    <span>in</span>
                    <span>{result.serverName}</span>
                  </>
                )}
                <span className="ml-auto">{formatTime(result.createdAt)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {result.displayName || result.username}
                </span>
              </div>
              <p className="line-clamp-2 text-sm text-[var(--text-secondary)]">
                {result.content}
              </p>
            </button>
          ))}

          {!loading && !query.trim() && (
            <div className="py-8 text-center text-sm text-[var(--text-muted)]">
              Search for messages across channels
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
