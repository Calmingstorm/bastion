import * as Dialog from '@radix-ui/react-dialog';

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isDeleting: boolean;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isDeleting,
}: DeleteConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
          <Dialog.Title className="text-lg font-bold text-[var(--text-primary)]">
            Delete Message
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--text-secondary)]">
            Are you sure you want to delete this message? This action cannot be undone.
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] hover:underline"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={onConfirm}
              disabled={isDeleting}
              className="rounded-[3px] bg-[var(--danger)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
