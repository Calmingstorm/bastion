import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as client from '../api/client';
import { openDirectMessage } from './dmActions';
import { useDMStore } from './dmStore';
import { useServerStore } from './serverStore';
import { invalidateSession } from '../api/session';
import type { DMChannel } from '../types';

// openDirectMessage is the shared path used by the server-context DM entry points
// (member context menu, profile card). It must go through the guarded dmStore.createDM
// and only switch to / select the DM when it belongs to the current session -- a DM
// created for an account that logged out mid-create must never be selected.
describe('openDirectMessage', () => {
  beforeEach(() => {
    useDMStore.getState().reset();
    useServerStore.setState({ selectedServerId: 's1', selectedChannelId: 'c1', servers: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a DM, leaves the server view, and selects it in the current session', async () => {
    vi.spyOn(client, 'apiCreateDM').mockResolvedValue({ id: 'dm-new' } as DMChannel);

    const dm = await openDirectMessage(['u1']);

    expect(dm?.id).toBe('dm-new');
    expect(useServerStore.getState().selectedServerId).toBeNull();
    expect(useServerStore.getState().selectedChannelId).toBeNull();
    expect(useDMStore.getState().selectedDMId).toBe('dm-new');
  });

  it('does not select or switch views when the session changed mid-create', async () => {
    let resolveCreate!: (dm: DMChannel) => void;
    vi.spyOn(client, 'apiCreateDM').mockImplementation(
      () =>
        new Promise((res) => {
          resolveCreate = res as (dm: DMChannel) => void;
        })
    );

    const pending = openDirectMessage(['u1']); // create is in flight
    invalidateSession(); // a new account logs in before it resolves
    resolveCreate({ id: 'dm-old' } as DMChannel);
    const dm = await pending;

    expect(dm).toBeUndefined();
    // The old-account DM must not have hijacked the new session's view.
    expect(useServerStore.getState().selectedServerId).toBe('s1');
    expect(useServerStore.getState().selectedChannelId).toBe('c1');
    expect(useDMStore.getState().selectedDMId).not.toBe('dm-old');
  });
});
