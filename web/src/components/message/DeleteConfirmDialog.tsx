import { ConfirmDialog } from '../ui/ConfirmDialog';

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
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title="Delete Message"
      description="Are you sure you want to delete this message? This action cannot be undone."
      confirmLabel="Delete"
      pendingLabel="Deleting..."
      isPending={isDeleting}
    />
  );
}
