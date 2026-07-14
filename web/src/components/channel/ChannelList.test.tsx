import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RefObject } from 'react';
import type { Server } from '../../types';

// Capture the shared delete-category dialog's props to prove ChannelList supplies
// returnFocusRef (the triggering category's button) AND a live isPending.
let confirmProps: {
  returnFocusRef?: RefObject<HTMLElement | null>;
  isPending?: boolean;
  onConfirm?: () => void;
} | null = null;
vi.mock('../ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    returnFocusRef?: RefObject<HTMLElement | null>;
    isPending?: boolean;
    onConfirm?: () => void;
  }) => {
    confirmProps = props;
    return null;
  },
}));

vi.mock('../../api/client', () => ({
  apiGetCategories: vi.fn(async () => [{ id: 'cat1', name: 'General', position: 0 }]),
  apiCreateCategory: vi.fn(),
  apiUpdateCategory: vi.fn(),
  apiDeleteCategory: vi.fn(() => new Promise(() => {})), // hangs so the pending state is observable
  apiReorderChannels: vi.fn(),
}));

import { ChannelList } from './ChannelList';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';

describe('ChannelList category-delete focus-return wiring', () => {
  beforeEach(() => {
    confirmProps = null;
    // Owner of the server -> canManageChannels, so the category context menu renders.
    useAuthStore.setState({ user: { id: 'u1', username: 'me' } as never, isAuthenticated: true });
    useServerStore.setState({
      servers: [{ id: 's1', name: 'S', ownerId: 'u1' } as Server],
      selectedServerId: 's1',
      channels: [],
      selectedChannelId: null,
      isLoadingChannels: false,
    });
  });

  it('gives the delete dialog a returnFocusRef pointing at the triggering category button', async () => {
    const user = userEvent.setup();
    render(<ChannelList />);
    // Category arrives from the (mocked) async fetch.
    const categoryButton = await screen.findByRole('button', { name: /General/ });

    // Open the category context menu and choose Delete Category.
    fireEvent.contextMenu(categoryButton);
    await user.click(await screen.findByText('Delete Category'));

    // The shared dialog must now target THIS category's persistent button.
    await waitFor(() => expect(confirmProps?.returnFocusRef?.current).toBe(categoryButton));
  });

  it('drives a live isPending: it goes true while the delete-category request is in flight', async () => {
    const user = userEvent.setup();
    render(<ChannelList />);
    const categoryButton = await screen.findByRole('button', { name: /General/ });
    fireEvent.contextMenu(categoryButton);
    await user.click(await screen.findByText('Delete Category')); // opens the dialog
    expect(confirmProps?.isPending).toBe(false);
    await act(async () => {
      confirmProps!.onConfirm!(); // start the (hanging) delete
    });
    expect(confirmProps?.isPending).toBe(true); // dialog is now locked
  });
});

// F38 round 17: category fetches are recency-owned within a session -- an OLDER
// request settling after a newer one must not overwrite its categories.
describe('ChannelList category fetch recency', () => {
  it('an older categories response cannot overwrite a newer one', async () => {
    useAuthStore.setState({ user: { id: 'owner-1' } as never });
    useServerStore.setState({
      servers: [{ id: 's1', name: 'S', ownerId: 'owner-1' } as Server],
      selectedServerId: 's1',
      channels: [],
    });
    let resolveOld!: (c: unknown[]) => void;
    let resolveNew!: (c: unknown[]) => void;
    vi.mocked((await import('../../api/client')).apiGetCategories)
      .mockImplementationOnce(() => new Promise((res) => { resolveOld = res; }) as never)
      .mockImplementationOnce(() => new Promise((res) => { resolveNew = res; }) as never);

    render(<ChannelList />); // mount fetch (held: OLD)

    const { eventBus } = await import('../../utils/eventBus');
    await act(async () => {
      eventBus.emit('bastion:category-update', {}); // refetch (held: NEW)
      resolveNew([{ id: 'cat-n', name: 'NewCat', position: 0 }]); // newer settles first
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText(/NewCat/)).toBeInTheDocument();

    await act(async () => {
      resolveOld([{ id: 'cat-o', name: 'OldCat', position: 0 }]); // older settles last
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText(/NewCat/)).toBeInTheDocument(); // newer kept
    expect(screen.queryByText(/OldCat/)).toBeNull(); // older discarded
  });
});
