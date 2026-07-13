import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Server, Channel, DMChannel } from '../types';

// Mock the API so tests control when each request settles. authStore.logout also
// pulls abortInFlightRequests/clearTokens from here.
vi.mock('../api/client', () => ({
  apiGetServers: vi.fn(),
  apiGetChannels: vi.fn(),
  apiCreateServer: vi.fn(),
  apiCreateChannel: vi.fn(),
  apiLeaveServer: vi.fn(),
  apiDeleteServer: vi.fn(),
  apiGetDMs: vi.fn(),
  apiCreateDM: vi.fn(),
  apiCloseDM: vi.fn(),
  apiGetReadStates: vi.fn(),
  apiAckChannel: vi.fn(),
  apiGetMemberPermissions: vi.fn(),
  apiLogin: vi.fn(),
  apiRegister: vi.fn(),
  apiGetMe: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  abortInFlightRequests: vi.fn(),
}));
// Keep logout's store reset a no-op so we can observe generation ordering cleanly.
vi.mock('./resetAll', () => ({ resetAllStores: vi.fn() }));

import * as client from '../api/client';
import { resetAllStores } from './resetAll';
import { useServerStore } from './serverStore';
import { useDMStore } from './dmStore';
import { useAuthStore } from './authStore';
import {
  captureSessionGeneration,
  isSessionGenerationCurrent,
  invalidateSession,
} from '../api/session';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('session-boundary guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.getState().reset();
    useDMStore.getState().reset();
  });

  it('a fetch that resolves after the session ends does not write (held read)', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 's', isLoadingServers: false });
    const d = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(d.promise);
    const p = useServerStore.getState().fetchServers();
    invalidateSession(); // identity boundary while the request is in flight
    d.resolve([{ id: 's-old', name: 'Old' } as Server]);
    await p;
    expect(useServerStore.getState().servers).toEqual([]); // stale response ignored
  });

  it('a fetch that rejects after the session ends does not set an error (held rejection)', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 's', error: null });
    const d = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(d.promise);
    const p = useServerStore.getState().fetchServers();
    invalidateSession();
    d.reject(new Error('boom'));
    await p;
    expect(useServerStore.getState().error).toBeNull(); // old rejection cannot set an error
  });

  it('a new-session fetch commits while an older one settles afterward, and the old one cannot clear the new loading state', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 's', isLoadingServers: false });
    const dOld = deferred<Server[]>();
    const dNew = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValueOnce(dOld.promise).mockReturnValueOnce(dNew.promise);
    const pOld = useServerStore.getState().fetchServers();
    invalidateSession();
    const pNew = useServerStore.getState().fetchServers();
    dOld.resolve([{ id: 's-old', name: 'Old' } as Server]); // old settles first
    await pOld;
    expect(useServerStore.getState().isLoadingServers).toBe(true); // old did NOT clear new loading
    dNew.resolve([{ id: 's-new', name: 'New' } as Server]);
    await pNew;
    expect(useServerStore.getState().servers).toEqual([{ id: 's-new', name: 'New' }]); // new committed
    expect(useServerStore.getState().isLoadingServers).toBe(false);
  });

  it('a multi-await action stops after the first await if the session changed (no second request)', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, isLoadingServers: false });
    const d = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(d.promise);
    vi.mocked(client.apiGetChannels).mockResolvedValue([]);
    const p = useServerStore.getState().fetchServers();
    invalidateSession(); // between the two awaits
    d.resolve([{ id: 's1', name: 'S' } as Server]); // would auto-select and fetch channels
    await p;
    expect(client.apiGetChannels).not.toHaveBeenCalled(); // second request never fired
    expect(useServerStore.getState().servers).toEqual([]);
  });

  it('a mutation that resolves after the session ends does not alter the new session (held mutation)', async () => {
    useServerStore.setState({ channels: [] });
    const d = deferred<Channel>();
    vi.mocked(client.apiCreateChannel).mockReturnValue(d.promise);
    const p = useServerStore.getState().createChannel('s1', 'general');
    invalidateSession();
    d.resolve({ id: 'c-old', name: 'general', serverId: 's1', position: 0 } as Channel);
    await p;
    expect(useServerStore.getState().channels).toEqual([]); // stale create not added
  });

  it('a value-returning mutation (createDM) returns undefined and does not add after the session ends', async () => {
    useDMStore.setState({ dmChannels: [] });
    const d = deferred<DMChannel>();
    vi.mocked(client.apiCreateDM).mockReturnValue(d.promise);
    const p = useDMStore.getState().createDM(['u2']);
    invalidateSession();
    d.resolve({ id: 'dm-old' } as DMChannel);
    const result = await p;
    expect(result).toBeUndefined(); // not returned as a new-session success
    expect(useDMStore.getState().dmChannels).toEqual([]);
  });

  it('logout advances the session generation BEFORE it aborts requests or resets stores', () => {
    const g = captureSessionGeneration();
    let currentWhenAbortRan: boolean | null = null;
    let currentWhenResetRan: boolean | null = null;
    vi.mocked(client.abortInFlightRequests).mockImplementation(() => {
      currentWhenAbortRan = isSessionGenerationCurrent(g);
    });
    vi.mocked(resetAllStores).mockImplementation(() => {
      currentWhenResetRan = isSessionGenerationCurrent(g);
    });
    useAuthStore.getState().logout();
    expect(isSessionGenerationCurrent(g)).toBe(false); // logout invalidated the session
    expect(currentWhenAbortRan).toBe(false); // ...before the abort ran
    expect(currentWhenResetRan).toBe(false); // ...and before the store reset ran
  });
});
