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
 * internal trigger ref and drops focus to <body>. On close:
 *  - CONFIRM: these are destructive actions that remove the launching control
 *    (sometimes asynchronously), so we send focus straight to the app's
 *    `[data-focus-fallback]` landmark -- restoring to a control that is about to
 *    unmount would orphan focus to <body>.
 *  - DISMISS (Escape/Cancel/backdrop): the control survives, so we restore focus to
 *    `returnFocusRef` if the caller gave one (required for menu-launched dialogs --
 *    see that prop) else the auto-captured opener, falling back to the landmark only
 *    if that target is unexpectedly gone.
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
  const confirmedRef = useRef(false);
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
            confirmedRef.current = false; // fresh for this open
          }}
          onCloseAutoFocus={(e) => {
            // Take over restoration (Radix cannot; see the component doc).
            e.preventDefault();
            // On CONFIRM these are destructive actions that remove the launching
            // control -- often asynchronously (e.g. a category delete refetch), so
            // restoring focus to it would land on the trigger and then orphan to
            // <body> once the refresh unmounts it. Go straight to the app landmark.
            if (confirmedRef.current) {
              document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
              return;
            }
            // On dismiss (Escape/Cancel/backdrop) the control survives. Restore to the
            // explicit returnFocusRef (menu callers) or the auto-captured opener
            // (ordinary buttons); if it is somehow gone, use the landmark.
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
              onClick={() => {
                confirmedRef.current = true; // close restores to the app landmark, not the doomed control
                onConfirm();
              }}
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
