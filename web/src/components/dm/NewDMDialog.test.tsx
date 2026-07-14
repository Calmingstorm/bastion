import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { NewDMDialog } from './NewDMDialog';
import { useDMStore } from '../../stores/dmStore';
import { invalidateSession } from '../../api/session';
import type { DMChannel, MessageAuthor } from '../../types';

// Drives the real dialog: search a user, select, and create. The create is routed
// through the guarded dmStore.createDM, so a create held across a session change must
// not select a DM built for the account that just logged out.
describe('NewDMDialog session guard', () => {
  beforeEach(() => {
    useDMStore.getState().reset();
    vi.spyOn(client, 'apiSearchUsers').mockResolvedValue([
      { id: 'u1', username: 'alice', displayName: 'Alice' } as MessageAuthor,
    ]);
    vi.spyOn(client, 'apiGetDMs').mockResolvedValue([]); // fetchDMs() after a create
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function selectAliceAndCreate(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByPlaceholderText('Search by username...'), 'alice');
    await user.click(await screen.findByText('@alice')); // pick the search result
    await user.click(screen.getByRole('button', { name: /Create DM/ }));
  }

  it('does not select a DM created for the previous account after a session change', async () => {
    const user = userEvent.setup();
    let resolveCreate!: (dm: DMChannel) => void;
    vi.spyOn(client, 'apiCreateDM').mockImplementation(
      () =>
        new Promise((res) => {
          resolveCreate = res as (dm: DMChannel) => void;
        })
    );
    const onOpenChange = vi.fn();

    render(<NewDMDialog open onOpenChange={onOpenChange} />);
    await selectAliceAndCreate(user); // create is now in flight (held)

    await act(async () => {
      invalidateSession(); // a new account logs in
      resolveCreate({ id: 'dm-old' } as DMChannel); // the old create resolves after
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useDMStore.getState().selectedDMId).not.toBe('dm-old');
    expect(onOpenChange).not.toHaveBeenCalledWith(false); // dialog not closed on stale
  });

  it('selects the DM and closes the dialog when the session is unchanged', async () => {
    const user = userEvent.setup();
    vi.spyOn(client, 'apiCreateDM').mockResolvedValue({ id: 'dm-new' } as DMChannel);
    const onOpenChange = vi.fn();

    render(<NewDMDialog open onOpenChange={onOpenChange} />);
    await selectAliceAndCreate(user);

    await waitFor(() => expect(useDMStore.getState().selectedDMId).toBe('dm-new'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
