import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Capture what DeleteConfirmDialog forwards to ConfirmDialog. If it stops forwarding
// isDeleting as isPending, the dialog would be dismissible mid-delete -- this fails.
let confirmProps: { isPending?: boolean } | null = null;
vi.mock('../ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: { isPending?: boolean }) => {
    confirmProps = props;
    return null;
  },
}));

import { DeleteConfirmDialog } from './DeleteConfirmDialog';

describe('DeleteConfirmDialog', () => {
  it('forwards isDeleting to the dialog as isPending', () => {
    confirmProps = null;
    render(
      <DeleteConfirmDialog open onOpenChange={() => {}} onConfirm={() => {}} isDeleting />
    );
    expect(confirmProps!.isPending).toBe(true);
  });

  it('is not pending when not deleting', () => {
    confirmProps = null;
    render(
      <DeleteConfirmDialog open onOpenChange={() => {}} onConfirm={() => {}} isDeleting={false} />
    );
    expect(confirmProps!.isPending).toBe(false);
  });
});
