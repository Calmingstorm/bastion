import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { MessageInput } from './MessageInput';
import { useServerStore } from '../../stores/serverStore';
import { eventBus } from '../../utils/eventBus';
import type { MemberWithUser, Channel } from '../../types';

// F38 round 17: the mention member list is recency-owned -- an OLDER fetch (the
// initial mount fetch) settling after a newer (event-driven) one must not
// overwrite its members.
describe('MessageInput member fetch recency', () => {
  beforeEach(() => {
    useServerStore.setState({
      selectedServerId: 's1',
      selectedChannelId: 'c1',
      channels: [{ id: 'c1', name: 'general', type: 'text', position: 0 } as Channel],
    });
    vi.spyOn(client, 'apiGetServerCommands').mockResolvedValue([]);
  });

  afterEach(() => {
    useServerStore.setState({ selectedServerId: null, selectedChannelId: null, channels: [] });
    vi.restoreAllMocks();
  });

  it('an older members response cannot overwrite a newer one in the mention list', async () => {
    const user = userEvent.setup();
    let resolveOld!: (m: MemberWithUser[]) => void;
    let resolveNew!: (m: MemberWithUser[]) => void;
    vi.spyOn(client, 'apiGetMembers')
      .mockImplementationOnce(
        () => new Promise((res) => { resolveOld = res as (m: MemberWithUser[]) => void; })
      )
      .mockImplementationOnce(
        () => new Promise((res) => { resolveNew = res as (m: MemberWithUser[]) => void; })
      );

    render(<MessageInput />); // mount members fetch (held: OLD)

    await act(async () => {
      eventBus.emit('bastion:member-join', {}); // event refetch (held: NEW)
      resolveNew([{ serverId: 's1', userId: 'un', username: 'newbie', role: 'member', status: 'online' } as MemberWithUser]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      resolveOld([{ serverId: 's1', userId: 'uo', username: 'oldie', role: 'member', status: 'online' } as MemberWithUser]);
      await new Promise((r) => setTimeout(r, 0));
    });

    // Open the mention autocomplete: the list must reflect the NEWER fetch.
    await user.type(screen.getByPlaceholderText('Message #general'), '@');
    expect(await screen.findByText(/newbie/)).toBeInTheDocument();
    expect(screen.queryByText(/oldie/)).toBeNull();
  });

  // F38 round 18: the member list is SERVER-owned -- switching servers clears the
  // previous server's members immediately, so they are never usable in the new
  // server's mention list while its fetch is in flight.
  it('a server switch clears the old members while the new fetch is held', async () => {
    const user = userEvent.setup();
    vi.spyOn(client, 'apiGetMembers')
      .mockResolvedValueOnce([
        { serverId: 's1', userId: 'ua', username: 'server-a-user', role: 'member', status: 'online' } as MemberWithUser,
      ])
      .mockImplementationOnce(() => new Promise(() => {})); // server B's fetch held

    render(<MessageInput />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0)); // A's members land
    });

    await act(async () => {
      useServerStore.setState({ selectedServerId: 's2' }); // switch; B held
      await new Promise((r) => setTimeout(r, 0));
    });

    await user.type(screen.getByPlaceholderText('Message #general'), '@');
    expect(screen.queryByText(/server-a-user/)).toBeNull(); // A's member not usable under B
  });
});
