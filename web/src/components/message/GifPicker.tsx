import { useState, useEffect, useRef, useCallback } from 'react';
import { apiSearchGifs, apiTrendingGifs } from '../../api/client';
import type { GifResult } from '../../api/client';

interface GifPickerProps {
  onSelect: (url: string) => void;
}

export function GifPicker({ onSelect }: GifPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

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

  // Load trending when opened
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiTrendingGifs(20).then(setGifs).catch(() => {}).finally(() => setLoading(false));
  }, [open]);

  // Debounced search
  const handleSearch = useCallback((q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setLoading(true);
      apiTrendingGifs(20).then(setGifs).catch(() => {}).finally(() => setLoading(false));
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      apiSearchGifs(q.trim(), 20).then(setGifs).catch(() => {}).finally(() => setLoading(false));
    }, 300);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-[11px] shrink-0 rounded px-1.5 py-0.5 text-xs font-bold text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
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
              placeholder="Search Tenor"
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
            Powered by Tenor
          </div>
        </div>
      )}
    </div>
  );
}
