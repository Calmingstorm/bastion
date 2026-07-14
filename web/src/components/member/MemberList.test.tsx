import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import * as client from '../../api/client';
import { MemberList } from './MemberList';
import { useServerStore } from '../../stores/serverStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { invalidateSession } from '../../api/session';
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
});
