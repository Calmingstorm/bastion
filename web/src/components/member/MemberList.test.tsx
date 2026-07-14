import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import * as client from '../../api/client';
import { MemberList } from './MemberList';
import { useServerStore } from '../../stores/serverStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { invalidateSession } from '../../api/session';
import { eventBus } from '../../utils/eventBus';
import type { MemberWithUser } from '../../types';

// F38 round 8: a members response settling after an identity boundary must not
// repopulate the NEW session's global presence store with the old account's members.
describe('MemberList session ownership', () => {
  beforeEach(() => {
    usePresenceStore.getState().reset();
    useServerStore.setState({ selectedServerId: 's1', servers: [], channels: [] });
  });

  afterEach(() => {
    usePresenceStore.getState().reset();
    useServerStore.setState({ selectedServerId: null });
    vi.restoreAllMocks();
  });

  it('a stale members response does not write presence into the new session', async () => {
    let resolveMembers!: (m: MemberWithUser[]) => void;
    vi.spyOn(client, 'apiGetMembers').mockImplementation(
      () =>
        new Promise((res) => {
          resolveMembers = res as (m: MemberWithUser[]) => void;
        })
    );

    render(<MemberList />); // mount fetch is now in flight (held)

    await act(async () => {
      invalidateSession(); // a new account logs in
      resolveMembers([
        { serverId: 's1', userId: 'old-member', username: 'old', role: 'member', status: 'away' } as MemberWithUser,
      ]);
      await new Promise((r) => setTimeout(r, 0));
    });

    // The old session's member presence must not exist in the new session's store.
    expect(usePresenceStore.getState().presences['old-member']).toBeUndefined();
  });

  // F38 round 9: only the LATEST fetch owns the loading flag. An old request
  // settling while a newer one is still in flight must not clear the spinner.
  it('an old members response does not clear the loading state of a newer fetch', async () => {
    let resolveFirst!: (m: MemberWithUser[]) => void;
    let resolveSecond!: (m: MemberWithUser[]) => void;
    vi.spyOn(client, 'apiGetMembers')
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res as (m: MemberWithUser[]) => void;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveSecond = res as (m: MemberWithUser[]) => void;
          })
      );

    const { container } = render(<MemberList />); // fetch 1 in flight (held)
    await act(async () => {
      eventBus.emit('bastion:member-join', {}); // refetch -> fetch 2 in flight (held)
    });

    await act(async () => {
      resolveFirst([]); // the OLD fetch settles while fetch 2 is still pending
      await new Promise((r) => setTimeout(r, 0));
    });
    // The spinner must still be visible -- fetch 2 owns the loading state.
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    await act(async () => {
      resolveSecond([
        { serverId: 's1', userId: 'm2', username: 'current', role: 'member', status: 'online' } as MemberWithUser,
      ]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('.animate-spin')).toBeNull(); // latest fetch cleared it
    expect(usePresenceStore.getState().presences['m2']).toBe('online'); // and committed
  });
});
