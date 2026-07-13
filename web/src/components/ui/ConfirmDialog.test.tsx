import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

// A controlled harness so onOpenChange actually toggles visibility (as in the
// real callers), letting us assert the dialog leaves the DOM on dismiss.
function Harness({
  onConfirm = vi.fn(),
  isPending = false,
  pendingLabel,
  startOpen = true,
}: {
  onConfirm?: () => void;
  isPending?: boolean;
  pendingLabel?: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button onClick={() => setOpen(true)}>trigger</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={onConfirm}
        title="Delete Channel"
        description="Are you sure you want to delete this? This cannot be undone."
        isPending={isPending}
        pendingLabel={pendingLabel}
      />
    </>
  );
}

// A harness whose confirm action REMOVES the opener (as a real deletion does) and
// that renders the app focus landmark, so we can prove the deletion fallback.
function FallbackHarness() {
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);
  return (
    <>
      <div data-focus-fallback tabIndex={-1}>
        app
      </div>
      {!deleted && <button onClick={() => setOpen(true)}>trigger</button>}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => {
          setDeleted(true); // the confirmed deletion removes the launching control
          setOpen(false);
        }}
        title="Delete Channel"
        description="Are you sure you want to delete this? This cannot be undone."
      />
    </>
  );
}

// Mimics a menu-launched dialog: the "menu item" that opens the dialog unmounts
// (like a context-menu portal closing), so the auto-captured opener is gone by
// close time -- the caller passes a stable returnFocusRef (the persistent trigger).
function MenuHarness({ removeTriggerOnConfirm = false }: { removeTriggerOnConfirm?: boolean }) {
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div data-focus-fallback tabIndex={-1}>
        app
      </div>
      {!deleted && <button ref={triggerRef}>persistent trigger</button>}
      {!open && <button onClick={() => setOpen(true)}>menu item</button>}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => {
          if (removeTriggerOnConfirm) setDeleted(true); // deletion removes the trigger too
          setOpen(false);
        }}
        title="Delete Category"
        description="Are you sure you want to delete this? This cannot be undone."
        returnFocusRef={triggerRef}
      />
    </>
  );
}

// A confirm that FAILS and leaves the dialog open (like a delete whose request
// rejected). A later dismissal must restore the opener, not the fallback.
function FailedConfirmHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div data-focus-fallback tabIndex={-1}>
        app
      </div>
      <button ref={triggerRef}>persistent trigger</button>
      {!open && <button onClick={() => setOpen(true)}>menu item</button>}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => {
          /* deletion failed: dialog stays open */
        }}
        title="Delete Category"
        description="Are you sure you want to delete this? This cannot be undone."
        returnFocusRef={triggerRef}
      />
    </>
  );
}

// A confirm whose async action stays pending until the test resolves it, then
// succeeds by removing the trigger and closing the dialog -- the real destructive
// lifecycle. The resolver is exposed at module scope because the open modal marks
// everything outside it inert, so a "resolve" button could not be clicked.
let resolvePendingDelete: (() => void) | null = null;
function PendingDeleteHarness() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div data-focus-fallback tabIndex={-1}>
        app
      </div>
      {!deleted && <button ref={triggerRef}>persistent trigger</button>}
      {!open && <button onClick={() => setOpen(true)}>menu item</button>}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        isPending={pending}
        onConfirm={() => {
          setPending(true);
          new Promise<void>((res) => {
            resolvePendingDelete = res;
          }).then(() => {
            setDeleted(true); // success removes the trigger
            setPending(false);
            setOpen(false); // and closes the dialog
          });
        }}
        title="Delete Category"
        description="Are you sure you want to delete this? This cannot be undone."
        returnFocusRef={triggerRef}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('exposes accessible dialog semantics and content when open', () => {
    render(<Harness />);
    // A hand-rolled overlay div would have no role — this asserts the Radix wiring.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Title/Description are wired to aria-labelledby/aria-describedby by Radix.
    expect(dialog).toHaveAccessibleName('Delete Channel');
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/i);
  });

  it('is absent from the DOM when closed', () => {
    render(<Harness startOpen={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the dialog when opened (focus trap)', async () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('dismisses on Escape without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('dismisses on Cancel without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('invokes onConfirm when the confirm button is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm button and shows the pending label while pending', () => {
    render(<Harness isPending pendingLabel="Deleting..." />);
    const confirm = screen.getByRole('button', { name: 'Deleting...' });
    expect(confirm).toBeDisabled();
  });

  // Focus restoration: a controlled Radix dialog with no Trigger would drop focus to
  // <body> on close; these prove focus returns to the element that opened it.
  it('restores focus to the opener after Escape', async () => {
    const user = userEvent.setup();
    render(<Harness startOpen={false} />);
    const trigger = screen.getByRole('button', { name: 'trigger' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the opener after Cancel', async () => {
    const user = userEvent.setup();
    render(<Harness startOpen={false} />);
    const trigger = screen.getByRole('button', { name: 'trigger' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the opener after a backdrop dismiss', async () => {
    const user = userEvent.setup();
    render(<Harness startOpen={false} />);
    const trigger = screen.getByRole('button', { name: 'trigger' });
    await user.click(trigger);
    // The overlay is the only .z-40 element (the content is .z-50); clicking it is an
    // interaction outside the content, which Radix treats as a dismiss.
    const overlay = document.querySelector('.z-40');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses the app fallback landmark when a confirmed deletion removes the opener', async () => {
    const user = userEvent.setup();
    render(<FallbackHarness />);
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The opener is gone; focus must land on the app landmark, never <body>.
    expect(document.activeElement).toBe(document.querySelector('[data-focus-fallback]'));
  });

  // Menu handoff: the element focused at open time is the (ephemeral) menu item, so
  // an explicit returnFocusRef -- the menu's persistent trigger -- must win.
  it('restores focus to returnFocusRef (not the gone menu opener) on a menu-launched dialog', async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);
    await user.click(screen.getByRole('button', { name: 'menu item' })); // opens; the item unmounts
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'persistent trigger' }));
  });

  it('a menu-launched dialog whose returnFocusRef target is removed on confirm uses the fallback', async () => {
    const user = userEvent.setup();
    render(<MenuHarness removeTriggerOnConfirm />);
    await user.click(screen.getByRole('button', { name: 'menu item' }));
    await user.click(screen.getByRole('button', { name: 'Delete' })); // removes the trigger too
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(document.querySelector('[data-focus-fallback]'));
  });

  it('confirm sends focus to the fallback even while the trigger still exists (async removal)', async () => {
    // Production category delete closes the dialog, then an async refetch unmounts
    // the trigger. If confirm restored focus to the still-present trigger, focus
    // would orphan to <body> when the refetch removes it. Here the trigger is NOT
    // removed on confirm, yet focus must still go to the fallback, not the trigger.
    const user = userEvent.setup();
    render(<MenuHarness />); // onConfirm closes but does not remove the trigger
    await user.click(screen.getByRole('button', { name: 'menu item' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const trigger = screen.getByRole('button', { name: 'persistent trigger' });
    expect(trigger).toBeInTheDocument(); // still here (removal would be async in prod)
    expect(document.activeElement).toBe(document.querySelector('[data-focus-fallback]'));
    expect(document.activeElement).not.toBe(trigger);
  });

  it('a failed confirm that leaves the dialog open, then dismissed, restores the opener', async () => {
    const user = userEvent.setup();
    render(<FailedConfirmHarness />);
    await user.click(screen.getByRole('button', { name: 'menu item' }));
    await user.click(screen.getByRole('button', { name: 'Delete' })); // confirm fails -> stays open
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}'); // the real close is a dismiss
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The control survived the failed delete, so focus returns to it, not the fallback.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'persistent trigger' }));
  });

  it('cannot be dismissed while a confirmed action is pending', async () => {
    const user = userEvent.setup();
    render(<Harness isPending pendingLabel="Deleting..." />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    // Locked: dismissal must not close it while the action runs.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('cannot be dismissed by a backdrop click while pending', async () => {
    const user = userEvent.setup();
    render(<Harness isPending />);
    const overlay = document.querySelector('.z-40'); // the overlay; content is .z-50
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);
    // The backdrop path (onInteractOutside) must also be locked while pending.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a dismissal attempt while pending is ignored, and a later successful deletion lands on the fallback', async () => {
    const user = userEvent.setup();
    render(<PendingDeleteHarness />);
    await user.click(screen.getByRole('button', { name: 'menu item' }));
    await user.click(screen.getByRole('button', { name: 'Delete' })); // -> pending
    await user.keyboard('{Escape}'); // dismissal attempt while pending -> ignored
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => {
      resolvePendingDelete?.(); // deletion succeeds: trigger removed, dialog closes
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The trigger is gone; focus must be on the app fallback, never <body>.
    expect(document.activeElement).toBe(document.querySelector('[data-focus-fallback]'));
  });
});
