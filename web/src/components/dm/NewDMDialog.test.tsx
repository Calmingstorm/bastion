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

  // F38 round 15: the user search is session+query owned -- an old-account response
  // must not render after invalidation, and a slower OLDER query must not overwrite
  // newer results.
  it('a stale-session search response is not rendered', async () => {
    const user = userEvent.setup();
    let resolveSearch!: (u: MessageAuthor[]) => void;
    vi.spyOn(client, 'apiSearchUsers').mockImplementation(
      () => new Promise((res) => { resolveSearch = res as (u: MessageAuthor[]) => void; })
    );
    render(<NewDMDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Search by username...'), 'old');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)); // past the debounce; search in flight
    });

    await act(async () => {
      invalidateSession();
      resolveSearch([{ id: 'u9', username: 'oldaccountuser' } as MessageAuthor]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/oldaccountuser/)).toBeNull();
  });

  it('clearing the input supersedes an in-flight search', async () => {
    const user = userEvent.setup();
    let resolveSearch!: (u: MessageAuthor[]) => void;
    vi.spyOn(client, 'apiSearchUsers').mockImplementation(
      () => new Promise((res) => { resolveSearch = res as (u: MessageAuthor[]) => void; })
    );
    render(<NewDMDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search by username...');
    await user.type(input, 'query');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)); // fired (held)
    });

    await user.clear(input);
    await act(async () => {
      resolveSearch([{ id: 'u9', username: 'stale-under-empty' } as MessageAuthor]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/stale-under-empty/)).toBeNull();
  });

  it('a slower older search cannot overwrite newer results', async () => {
    const user = userEvent.setup();
    let resolveFirst!: (u: MessageAuthor[]) => void;
    let resolveSecond!: (u: MessageAuthor[]) => void;
    vi.spyOn(client, 'apiSearchUsers')
      .mockImplementationOnce(
        () => new Promise((res) => { resolveFirst = res as (u: MessageAuthor[]) => void; })
      )
      .mockImplementationOnce(
        () => new Promise((res) => { resolveSecond = res as (u: MessageAuthor[]) => void; })
      );
    render(<NewDMDialog open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search by username...');

    await user.type(input, 'al');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)); // query 1 fired (held)
    });
    await user.type(input, 'ice');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350)); // query 2 fired (held)
    });

    await act(async () => {
      resolveSecond([{ id: 'u1', username: 'alice-new' } as MessageAuthor]); // newer first
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      resolveFirst([{ id: 'u2', username: 'al-old' } as MessageAuthor]); // older last
      await new Promise((r) => setTimeout(r, 0));
    });

    // (The result row renders the name twice: display name + @username.)
    expect(screen.getAllByText(/alice-new/).length).toBeGreaterThan(0); // newer kept
    expect(screen.queryByText(/al-old/)).toBeNull(); // older discarded
  });

  it('selects the DM, enters DM scope, and closes the dialog when the session is unchanged', async () => {
    const user = userEvent.setup();
    const { useServerStore } = await import('../../stores/serverStore');
    useServerStore.setState({ selectedServerId: 's1', selectedChannelId: 'c1' });
    vi.spyOn(client, 'apiCreateDM').mockResolvedValue({ id: 'dm-new' } as DMChannel);
    const onOpenChange = vi.fn();

    render(<NewDMDialog open onOpenChange={onOpenChange} />);
    await selectAliceAndCreate(user);

    await waitFor(() => expect(useDMStore.getState().selectedDMId).toBe('dm-new'));
    // The dialog ENTERS DM scope: layouts rendering selectedChannelId || selectedDMId
    // must show the new DM, not the still-selected server channel.
    expect(useServerStore.getState().selectedServerId).toBeNull();
    expect(useServerStore.getState().selectedChannelId).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    useServerStore.getState().reset();
  });

  // F38 round 6: the workflow spans more than the create -- a session change during
  // the post-create fetchDMs() must also stop the select/close. The dialog owns the
  // whole sequence with one generation captured at its start.
  it('does not select or close when the session changes during the post-create fetch', async () => {
    const user = userEvent.setup();
    vi.spyOn(client, 'apiCreateDM').mockResolvedValue({ id: 'dm-new' } as DMChannel);
    let resolveGetDMs!: (dms: DMChannel[]) => void;
    const getDMsSpy = vi.spyOn(client, 'apiGetDMs').mockImplementation(
      () =>
        new Promise((res) => {
          resolveGetDMs = res as (dms: DMChannel[]) => void;
        })
    );
    const onOpenChange = vi.fn();

    render(<NewDMDialog open onOpenChange={onOpenChange} />);
    await selectAliceAndCreate(user); // create succeeded; fetchDMs now in flight
    await waitFor(() => expect(getDMsSpy).toHaveBeenCalled());

    await act(async () => {
      invalidateSession(); // a new account logs in during the fetch
      resolveGetDMs([]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useDMStore.getState().selectedDMId).not.toBe('dm-new');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
