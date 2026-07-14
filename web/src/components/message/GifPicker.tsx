import { useState, useEffect, useRef, useCallback } from 'react';
import { apiSearchGifs, apiTrendingGifs } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import type { GifResult } from '../../api/client';
import { useFeatureStore } from '../../stores/featureStore';

interface GifPickerProps {
  onSelect: (url: string) => void;
}

export function GifPicker({ onSelect }: GifPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const gifProvider = useFeatureStore((s) => s.features.gifProvider);

  const providerName = gifProvider === 'giphy' ? 'GIPHY' : 'Tenor';

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Only the LATEST query lineage owns the grid (session + query recency). The
  // lineage is claimed on EVERY query change -- not when the debounced request
  // fires -- so an already-fired older request cannot publish beneath a newly
  // typed query during the debounce gap.
  const gifSeqRef = useRef(0);
  const fireOwned = useCallback((seq: number, fetcher: () => Promise<GifResult[]>) => {
    const generation = captureSessionGeneration();
    const owns = () => seq === gifSeqRef.current && isSessionGenerationCurrent(generation);
    setLoading(true);
    fetcher()
      .then((g) => {
        if (owns()) setGifs(g);
      })
      .catch(() => {})
      .finally(() => {
        if (owns()) setLoading(false);
      });
  }, []);

  // Load trending when opened
  useEffect(() => {
    if (!open) return;
    fireOwned(++gifSeqRef.current, () => apiTrendingGifs(20));
  }, [open, fireOwned]);

  // Debounced search
  const handleSearch = useCallback((q: string) => {
    setQuery(q);
    const seq = ++gifSeqRef.current; // every keystroke supersedes in-flight work
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      fireOwned(seq, () => apiTrendingGifs(20));
      return;
    }
    debounceRef.current = setTimeout(() => {
      fireOwned(seq, () => apiSearchGifs(q.trim(), 20));
    }, 300);
  }, [fireOwned]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        title="GIF"
        type="button"
      >
        GIF
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex w-[340px] flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] shadow-xl">
          {/* Search input */}
          <div className="border-b border-[var(--border)] p-2">
            <input
              type="text"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={`Search ${providerName}`}
              className="w-full rounded bg-[var(--bg-input)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
              autoFocus
            />
          </div>

          {/* GIF grid */}
          <div className="h-[300px] overflow-y-auto p-2">
            {loading && gifs.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
              </div>
            ) : (
              <div className="columns-2 gap-1.5">
                {gifs.map((gif) => (
                  <button
                    key={gif.id}
                    onClick={() => {
                      onSelect(gif.url);
                      setOpen(false);
                      setQuery('');
                    }}
                    type="button"
                    className="mb-1.5 block w-full overflow-hidden rounded transition-opacity hover:opacity-80"
                  >
                    <img
                      src={gif.previewUrl}
                      alt={gif.title}
                      loading="lazy"
                      className="w-full rounded"
                    />
                  </button>
                ))}
              </div>
            )}
            {!loading && gifs.length === 0 && (
              <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                No GIFs found
              </div>
            )}
          </div>

          {/* Attribution */}
          <div className="border-t border-[var(--border)] px-2 py-1 text-center text-[10px] text-[var(--text-muted)]">
            Powered by {providerName}
          </div>
        </div>
      )}
    </div>
  );
}
