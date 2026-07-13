interface MessageLoadErrorProps {
  error: string;
  onRetry: () => void;
}

// Shown when a channel's latest-window load failed (e.g. a stuck fetch was
// abandoned) and there are no messages to display -- a Retry rather than a
// misleading "no messages yet" empty state.
export function MessageLoadError({ error, onRetry }: MessageLoadErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <p className="text-sm text-[var(--text-muted)]">{error}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-[3px] bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90"
      >
        Retry
      </button>
    </div>
  );
}
