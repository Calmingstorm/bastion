import { useToastStore } from '../stores/toastStore';

// Renders transient error toasts (e.g. a failed send/edit/delete) so a mutation
// failure is never silently swallowed.
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-md bg-[var(--danger)] px-4 py-2 text-sm text-white shadow-lg"
        >
          <span>{t.message}</span>
          <button
            type="button"
            onClick={() => removeToast(t.id)}
            className="text-white/80 transition-colors hover:text-white"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
