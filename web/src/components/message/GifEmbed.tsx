import { useState, useEffect } from 'react';
import { apiUnfurl } from '../../api/client';

// Module-level cache to avoid repeated API calls across re-renders
const urlCache = new Map<string, string>();

interface GifEmbedProps {
  url: string;
}

export function GifEmbed({ url }: GifEmbedProps) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(() => urlCache.get(url) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (mediaUrl || failed) return;

    let cancelled = false;
    apiUnfurl(url)
      .then((result) => {
        if (cancelled) return;
        if (!result.mediaUrl) {
          // Provider not configured or no media found — show as plain link
          setFailed(true);
          return;
        }
        urlCache.set(url, result.mediaUrl);
        setMediaUrl(result.mediaUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });

    return () => { cancelled = true; };
  }, [url, mediaUrl, failed]);

  // Failed to resolve — show as a plain link
  if (failed) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
        {url}
      </a>
    );
  }

  // Still loading
  if (!mediaUrl) {
    return (
      <div className="my-1 flex h-[200px] w-[300px] items-center justify-center rounded-lg bg-[var(--bg-tertiary)]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="image-embed my-1 min-h-[200px]">
      <img
        src={mediaUrl}
        alt=""
        loading="lazy"
        className="max-w-[400px] max-h-[300px] rounded-lg object-contain"
      />
    </div>
  );
}
