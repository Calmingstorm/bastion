import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the heavy children and the scroll hook so we can render MessageList and
// exercise only its latest-window error -> Retry wiring.
vi.mock('./MessageItem', () => ({ MessageItem: () => null, DateSeparator: () => null }));
vi.mock('./TypingIndicator', () => ({ TypingIndicator: () => null }));
vi.mock('../search/SearchDialog', () => ({ SearchDialog: () => null }));
vi.mock('./PinnedMessages', () => ({ PinnedMessages: () => null }));
vi.mock('../user/PresenceDot', () => ({ PresenceDot: () => null }));
vi.mock('../../hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({ containerRef: { current: null }, scrollToBottomPersistent: () => {} }),
}));

import { MessageList } from './MessageList';
import { useMessageStore } from '../../stores/messageStore';
import { useServerStore } from '../../stores/serverStore';

describe('MessageList latest-window error', () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    useServerStore.setState({
      selectedChannelId: 'c1',
      channels: [{ id: 'c1', name: 'general', type: 'text', position: 0 }],
    });
  });

  it('shows a Retry (not the empty state) when the channel failed to load, and retries on click', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve());
    const retrySpy = vi.fn();
    useMessageStore.setState({
      messages: { c1: [] },
      isLoading: { c1: false },
      error: { c1: 'Failed to load messages.' },
      errorSeq: { c1: 7 }, // the error generation the Retry must carry
      fetchMessages: fetchSpy,
      retryLoad: retrySpy,
    });

    render(<MessageList onToggleMembers={() => {}} onToggleSidebar={() => {}} />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText(/No messages yet/)).not.toBeInTheDocument(); // not the misleading empty state
    await userEvent.click(retry);
    // The Retry carries the error generation so a stale click is a no-op in the store.
    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith('c1', 7));
  });
});
