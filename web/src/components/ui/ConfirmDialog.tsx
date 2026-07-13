import { useRef, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button uses danger styling. Defaults to true. */
  destructive?: boolean;
  /** Disables the confirm button and shows pendingLabel while an action is in flight. */
  isPending?: boolean;
  pendingLabel?: string;
  /**
   * Explicit, stable element to return focus to on close. Pass this from a caller
   * that opens the dialog from a menu (e.g. a Radix context menu): by the time the
   * dialog captures focus, the menu portal that held it has unmounted, so the
   * auto-captured opener is unreliable -- point this at the menu's persistent
   * trigger instead. Ordinary button callers omit it and rely on the auto capture.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Accessible confirmation dialog shared by every destructive/confirm prompt.
 *
 * Built on Radix Dialog so it gets, for free: role="dialog" + aria-modal, a focus
 * trap, Escape-to-dismiss, backdrop dismiss, and Title/Description wired to
 * aria-labelledby/aria-describedby.
 *
 * Focus restoration is handled here rather than by Radix: this is a CONTROLLED
 * dialog with no `Dialog.Trigger`, so Radix's built-in restoration targets an empty
 * internal trigger ref and drops focus to <body>. Instead, on close we return focus
 * to `returnFocusRef` if the caller gave one (required for menu-launched dialogs --
 * see that prop), else to the auto-captured opener; and if that target is gone (a
 * confirmed deletion removed it), to the app's `[data-focus-fallback]` landmark so
 * focus never lands on <body>.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  isPending = false,
  pendingLabel,
  returnFocusRef,
}: ConfirmDialogProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const confirmClasses = destructive
    ? 'bg-[var(--danger)] hover:bg-red-600'
    : 'bg-[var(--accent)] hover:opacity-90';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content
          onOpenAutoFocus={() => {
            // Remember the opener BEFORE Radix moves focus into the dialog. Do not
            // preventDefault -- we still want focus trapped inside while it is open.
            openerRef.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(e) => {
            // Take over restoration (see the component doc). An explicit
            // returnFocusRef (menu callers) is authoritative; otherwise use the
            // auto-captured opener (ordinary buttons). If that target is gone -- a
            // confirmed deletion removed it -- fall back to the app's focus landmark
            // rather than letting focus drop to <body>.
            e.preventDefault();
            const target = returnFocusRef ? returnFocusRef.current : openerRef.current;
            if (target && document.contains(target) && typeof target.focus === 'function') {
              target.focus();
              return;
            }
            document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl"
        >
          <Dialog.Title className="text-lg font-bold text-[var(--text-primary)]">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--text-secondary)]">
            {description}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:underline"
              >
                {cancelLabel}
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className={`rounded-[3px] px-4 py-2.5 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${confirmClasses}`}
            >
              {isPending ? (pendingLabel ?? confirmLabel) : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
