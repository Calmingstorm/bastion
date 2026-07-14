import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RefObject } from 'react';
import type { Server } from '../../types';

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
  apiGetCategories: vi.fn(async () => [{ id: 'cat1', name: 'Ops', position: 0 }]),
  apiCreateCategory: vi.fn(),
  apiUpdateCategory: vi.fn(),
  apiDeleteCategory: vi.fn(() => new Promise(() => {})), // hangs so the pending state is observable
  apiCreateChannel: vi.fn(),
  apiGetChannels: vi.fn(async () => []),
}));

import { UnifiedSidebar } from './UnifiedSidebar';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';

describe('UnifiedSidebar category-delete focus-return wiring', () => {
  beforeEach(() => {
    confirmProps = null;
    useAuthStore.setState({ user: { id: 'u1', username: 'me' } as never, isAuthenticated: true });
    useDMStore.setState({ dmChannels: [], selectedDMId: null });
    useServerStore.setState({
      servers: [{ id: 's1', name: 'S', ownerId: 'u1' } as Server],
      selectedServerId: 's1', // -> expandedServerId defaults to this, so its categories render
      channels: [],
      selectedChannelId: null,
      isLoadingChannels: false,
    });
  });

  it('gives the delete dialog a returnFocusRef pointing at the triggering category button', async () => {
    const user = userEvent.setup();
    render(<UnifiedSidebar />);
    const categoryButton = await screen.findByRole('button', { name: /Ops/ });

    fireEvent.contextMenu(categoryButton);
    await user.click(await screen.findByText('Delete Category'));

    await waitFor(() => expect(confirmProps?.returnFocusRef?.current).toBe(categoryButton));
  });

  it('drives a live isPending: it goes true while the delete-category request is in flight', async () => {
    const user = userEvent.setup();
    render(<UnifiedSidebar />);
    const categoryButton = await screen.findByRole('button', { name: /Ops/ });
    fireEvent.contextMenu(categoryButton);
    await user.click(await screen.findByText('Delete Category'));
    expect(confirmProps?.isPending).toBe(false);
    await act(async () => {
      confirmProps!.onConfirm!();
    });
    expect(confirmProps?.isPending).toBe(true);
  });
});

// F38 round 17: category fetches are recency-owned within a session -- an OLDER
// request settling after a newer one must not overwrite its categories.
describe('UnifiedSidebar category fetch recency', () => {
  it('an older categories response cannot overwrite a newer one', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'me' } as never, isAuthenticated: true });
    useDMStore.setState({ dmChannels: [], selectedDMId: null });
    useServerStore.setState({
      servers: [{ id: 's1', name: 'S', ownerId: 'u1' } as Server],
      selectedServerId: 's1',
      channels: [],
      selectedChannelId: null,
      isLoadingChannels: false,
    });
    let resolveOld!: (c: unknown[]) => void;
    let resolveNew!: (c: unknown[]) => void;
    vi.mocked((await import('../../api/client')).apiGetCategories)
      .mockImplementationOnce(() => new Promise((res) => { resolveOld = res; }) as never)
      .mockImplementationOnce(() => new Promise((res) => { resolveNew = res; }) as never);

    render(<UnifiedSidebar />); // mount fetch (held: OLD)

    const { eventBus } = await import('../../utils/eventBus');
    await act(async () => {
      eventBus.emit('bastion:category-update', {}); // refetch (held: NEW)
      resolveNew([{ id: 'cat-n', name: 'NewCat', position: 0 }]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(await screen.findByText(/NewCat/)).toBeInTheDocument();

    await act(async () => {
      resolveOld([{ id: 'cat-o', name: 'OldCat', position: 0 }]); // older settles last
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText(/NewCat/)).toBeInTheDocument();
    expect(screen.queryByText(/OldCat/)).toBeNull();
  });
});

describe('UnifiedSidebar category server scope', () => {
  it('a server switch clears the old categories even when the new fetch fails', async () => {
    useAuthStore.setState({ user: { id: 'u1', username: 'me' } as never, isAuthenticated: true });
    useDMStore.setState({ dmChannels: [], selectedDMId: null });
    useServerStore.setState({
      servers: [
        { id: 's1', name: 'S1', ownerId: 'u1' } as Server,
        { id: 's2', name: 'S2', ownerId: 'u1' } as Server,
      ],
      selectedServerId: 's1',
      channels: [],
      selectedChannelId: null,
      isLoadingChannels: false,
    });
    const api = await import('../../api/client');
    vi.mocked(api.apiGetCategories)
      .mockResolvedValueOnce([{ id: 'cat-a', name: 'SidebarACat', position: 0 }] as never)
      .mockRejectedValueOnce(new Error('server B categories failed'));

    render(<UnifiedSidebar />);
    expect(await screen.findByText(/SidebarACat/)).toBeInTheDocument();

    await act(async () => {
      useServerStore.setState({ selectedServerId: 's2' }); // switch; B's fetch fails
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/SidebarACat/)).toBeNull();
  });
});
