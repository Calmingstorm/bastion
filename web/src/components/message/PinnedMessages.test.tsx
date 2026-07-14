import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { PinnedMessages } from './PinnedMessages';
import { invalidateSession } from '../../api/session';
import { eventBus } from '../../utils/eventBus';
import type { PinnedMessage } from '../../types';

// F38 round 15: the pins read and unpin continuation are owned by the session and
// the list they started for. Held old-session responses must neither render nor
// complete loading, and a stale unpin completion must not edit the current list.
describe('PinnedMessages session ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function pin(id: string, content: string): PinnedMessage {
    return {
      id, channelId: 'c1', content, createdAt: '2026-01-01T00:00:00Z',
      pinnedAt: '2026-01-02T00:00:00Z', author: { id: 'u1', username: 'someone' },
    } as PinnedMessage;
  }

  it('a stale pins response renders nothing and never completes loading', async () => {
    let resolvePins!: (p: PinnedMessage[]) => void;
    vi.spyOn(client, 'apiGetPinnedMessages').mockImplementation(
      () => new Promise((res) => { resolvePins = res as (p: PinnedMessage[]) => void; })
    );
    render(<PinnedMessages open onOpenChange={vi.fn()} channelId="c1" />);

    await act(async () => {
      invalidateSession();
      resolvePins([pin('m1', 'old-pinned-content')]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/old-pinned-content/)).toBeNull();
    // The dialog renders in a portal, so query the document for the spinner.
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('an event refresh that supersedes the initial fetch clears loading and shows its pins', async () => {
    let resolveInitial!: (p: PinnedMessage[]) => void;
    let resolveRefresh!: (p: PinnedMessage[]) => void;
    vi.spyOn(client, 'apiGetPinnedMessages')
      .mockImplementationOnce(
        () => new Promise((res) => { resolveInitial = res as (p: PinnedMessage[]) => void; })
      )
      .mockImplementationOnce(
        () => new Promise((res) => { resolveRefresh = res as (p: PinnedMessage[]) => void; })
      );
    render(<PinnedMessages open onOpenChange={vi.fn()} channelId="c1" />); // initial held

    await act(async () => {
      eventBus.emit('bastion:pin-update', {}); // refresh supersedes the initial fetch
      resolveRefresh([pin('m2', 'refreshed-pin')]);
      await new Promise((r) => setTimeout(r, 0));
    });

    // The owning refresh committed AND cleared loading -- no permanent spinner.
    expect(screen.getByText(/refreshed-pin/)).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeNull();

    await act(async () => {
      resolveInitial([pin('m1', 'superseded-initial')]); // the held initial settles late
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText(/superseded-initial/)).toBeNull(); // and commits nothing
  });

  it('a successful unpin applies even when its own event advances the sequence', async () => {
    vi.spyOn(client, 'apiGetPinnedMessages')
      .mockResolvedValueOnce([pin('m1', 'to-be-unpinned')])
      .mockRejectedValueOnce(new Error('refresh failed')); // the event-driven refetch fails
    let resolveUnpin!: () => void;
    vi.spyOn(client, 'apiUnpinMessage').mockImplementation(
      () => new Promise<void>((res) => { resolveUnpin = () => res(); })
    );
    const user = userEvent.setup();
    render(<PinnedMessages open onOpenChange={vi.fn()} channelId="c1" />);
    await screen.findByText(/to-be-unpinned/);

    await user.click(screen.getByRole('button', { name: 'Unpin' })); // held

    await act(async () => {
      eventBus.emit('bastion:pin-update', {}); // the unpin's own WS event: refetch fails
      await new Promise((r) => setTimeout(r, 0));
      resolveUnpin(); // the unpin completes AFTER the sequence advanced
      await new Promise((r) => setTimeout(r, 0));
    });

    // The unpin's filter still applies -- the removed pin must not remain visible.
    expect(screen.queryByText(/to-be-unpinned/)).toBeNull();
  });

  it('a stale unpin completion does not edit the current session list', async () => {
    vi.spyOn(client, 'apiGetPinnedMessages').mockResolvedValue([pin('m1', 'still-pinned')]);
    let resolveUnpin!: () => void;
    vi.spyOn(client, 'apiUnpinMessage').mockImplementation(
      () => new Promise<void>((res) => { resolveUnpin = () => res(); })
    );
    const user = userEvent.setup();
    render(<PinnedMessages open onOpenChange={vi.fn()} channelId="c1" />);
    await screen.findByText(/still-pinned/);

    await user.click(screen.getByRole('button', { name: 'Unpin' })); // held

    await act(async () => {
      invalidateSession(); // a new account logs in while the unpin is in flight
      resolveUnpin();
      await new Promise((r) => setTimeout(r, 0));
    });

    // The old workflow's completion must not edit the (new session's) list.
    expect(screen.getByText(/still-pinned/)).toBeInTheDocument();
  });
});
