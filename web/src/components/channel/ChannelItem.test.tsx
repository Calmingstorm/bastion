import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { RefObject } from 'react';
import type { Channel } from '../../types';

// Capture the props ConfirmDialog is rendered with, so we can prove ChannelItem
// supplies returnFocusRef (pointing at the channel button) AND a live isPending.
// Removing either wiring must fail a test here.
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
  apiUpdateChannel: vi.fn(),
  apiDeleteChannel: vi.fn(() => new Promise(() => {})), // hangs so the pending state is observable
}));

import { ChannelItem } from './ChannelItem';
import { apiDeleteChannel } from '../../api/client';
import { useServerStore } from '../../stores/serverStore';
import { invalidateSession } from '../../api/session';

const channel = { id: 'c1', name: 'general', type: 'text', position: 0 } as Channel;

describe('ChannelItem focus-return wiring', () => {
  it('gives the delete dialog a returnFocusRef pointing at the channel button', () => {
    confirmProps = null;
    render(<ChannelItem channel={channel} isSelected={false} onClick={() => {}} canManage />);
    const button = screen.getByRole('button', { name: /general/ });
    expect(confirmProps).not.toBeNull();
    // The context menu that opens the delete dialog unmounts on close, so the dialog
    // needs this stable trigger to restore focus to.
    expect(confirmProps!.returnFocusRef).toBeDefined();
    expect(confirmProps!.returnFocusRef!.current).toBe(button);
  });

  it('drives a live isPending: it goes true while the delete request is in flight', async () => {
    confirmProps = null;
    render(<ChannelItem channel={channel} isSelected={false} onClick={() => {}} canManage serverId="s1" />);
    expect(confirmProps!.isPending).toBe(false);
    await act(async () => {
      confirmProps!.onConfirm!(); // start the (hanging) delete
    });
    expect(confirmProps!.isPending).toBe(true); // dialog is now locked
  });

  // F38 round 7: channel ids are stable across sessions. A delete that settles after
  // an identity boundary must not remove a same-ID channel the NEW session loaded.
  it('a delete settling after a session change does not remove a same-ID channel from the new session', async () => {
    confirmProps = null;
    let resolveDelete!: () => void;
    vi.mocked(apiDeleteChannel).mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          resolveDelete = () => res();
        })
    );
    // The new session has a channel with the SAME id loaded.
    useServerStore.setState({ channels: [channel], selectedChannelId: null });

    render(<ChannelItem channel={channel} isSelected={false} onClick={() => {}} canManage serverId="s1" />);
    await act(async () => {
      confirmProps!.onConfirm!(); // delete in flight (held)
    });

    await act(async () => {
      invalidateSession(); // a new account logs in
      resolveDelete(); // the old delete then completes
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useServerStore.getState().channels).toEqual([channel]); // not removed
    useServerStore.setState({ channels: [], selectedChannelId: null });
  });
});
