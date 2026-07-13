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
import type { LoginResponse, ReadState } from '../types';
import { resetAllStores } from './resetAll';
import { useServerStore } from './serverStore';
import { useDMStore } from './dmStore';
import { useUnreadStore } from './unreadStore';
import { usePermissionStore } from './permissionStore';
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

  it('unreadStore.fetchReadStates: a response after the session ends does not write', async () => {
    useUnreadStore.setState({ readStates: {} });
    const d = deferred<ReadState[]>();
    vi.mocked(client.apiGetReadStates).mockReturnValue(d.promise);
    const p = useUnreadStore.getState().fetchReadStates();
    invalidateSession();
    d.resolve([{ channelId: 'c-old', userId: 'u', lastMessageId: 'm', lastReadAt: '', mentionCount: 0 } as ReadState]);
    await p;
    expect(useUnreadStore.getState().readStates).toEqual({});
  });

  it('unreadStore.ackChannel: an ack that resolves after the session ends does not write', async () => {
    useUnreadStore.setState({ readStates: {}, unreadChannels: new Set(['c1']) });
    const d = deferred<void>();
    vi.mocked(client.apiAckChannel).mockReturnValue(d.promise);
    const p = useUnreadStore.getState().ackChannel('c1', 'm1');
    invalidateSession();
    d.resolve();
    await p;
    expect(useUnreadStore.getState().readStates).toEqual({}); // no read-state written
    expect(useUnreadStore.getState().unreadChannels.has('c1')).toBe(true); // not cleared
  });

  it('permissionStore.fetchPermissions: a response after the session ends does not write', async () => {
    usePermissionStore.setState({ permissions: {} });
    const d = deferred<{ permissions: number }>();
    vi.mocked(client.apiGetMemberPermissions).mockReturnValue(d.promise);
    const p = usePermissionStore.getState().fetchPermissions('s-old');
    invalidateSession();
    d.resolve({ permissions: 7 });
    await p;
    expect(usePermissionStore.getState().permissions).toEqual({});
  });

  it('a login response resolving after a newer identity boundary does not resurrect the session', async () => {
    useAuthStore.setState({ isAuthenticated: false, user: null });
    const d = deferred<LoginResponse>();
    vi.mocked(client.apiLogin).mockReturnValue(d.promise);
    const p = useAuthStore.getState().login('a@b.c', 'pw'); // invalidates + captures at entry
    invalidateSession(); // a newer boundary (concurrent login / logout) supersedes it
    d.resolve({ user: { id: 'u-old', username: 'old' }, accessToken: 'a', refreshToken: 'r' } as LoginResponse);
    await p;
    expect(useAuthStore.getState().isAuthenticated).toBe(false); // stale login did not authenticate
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('register advances the session generation at entry (establishes a new identity)', () => {
    const g = captureSessionGeneration();
    vi.mocked(client.apiRegister).mockReturnValue(new Promise(() => {})); // hangs
    void useAuthStore.getState().register('u', 'a@b.c', 'pw');
    expect(isSessionGenerationCurrent(g)).toBe(false); // prior generation invalidated
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
