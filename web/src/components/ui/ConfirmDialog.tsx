import type { ReactNode } from 'react';
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
}

/**
 * Accessible confirmation dialog shared by every destructive/confirm prompt.
 *
 * Built on Radix Dialog so it gets, for free, the semantics the hand-rolled
 * `fixed inset-0` overlays lacked: role="dialog" + aria-modal, a focus trap,
 * focus restore to the trigger on close, Escape-to-dismiss, backdrop dismiss,
 * and Title/Description wired to aria-labelledby/aria-describedby.
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
}: ConfirmDialogProps) {
  const confirmClasses = destructive
    ? 'bg-[var(--danger)] hover:bg-red-600'
    : 'bg-[var(--accent)] hover:opacity-90';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
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
