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
