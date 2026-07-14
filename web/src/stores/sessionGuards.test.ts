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
  apiGetServerCommands: vi.fn(),
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
import type { LoginResponse, ReadState, ApplicationCommand } from '../types';
import { resetAllStores } from './resetAll';
import { useServerStore } from './serverStore';
import { useDMStore } from './dmStore';
import { useUnreadStore } from './unreadStore';
import { usePermissionStore } from './permissionStore';
import { useCommandStore } from './commandStore';
import { useToastStore } from './toastStore';
import { useAuthStore } from './authStore';
import {
  captureSessionGeneration,
  isSessionGenerationCurrent,
  invalidateSession,
  SessionSupersededError,
} from '../api/session';
import { storage } from '../utils/storage';

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

  it('a mutation that resolves after the session ends REJECTS and does not alter the new session (held mutation)', async () => {
    useServerStore.setState({ channels: [] });
    const d = deferred<Channel>();
    vi.mocked(client.apiCreateChannel).mockReturnValue(d.promise);
    const p = useServerStore.getState().createChannel('s1', 'general');
    invalidateSession();
    d.resolve({ id: 'c-old', name: 'general', serverId: 's1', position: 0 } as Channel);
    // F38 round 7: a superseded mutation must not FULFILL -- a caller cannot tell a
    // silent stale return from success and would run its success UI.
    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
    expect(useServerStore.getState().channels).toEqual([]); // stale create not added
  });

  it('createServer superseded mid-flight rejects with SessionSupersededError and adds nothing', async () => {
    useServerStore.setState({ servers: [] });
    const d = deferred<Server>();
    vi.mocked(client.apiCreateServer).mockReturnValue(d.promise);
    const p = useServerStore.getState().createServer('new-server');
    invalidateSession();
    d.resolve({ id: 's-old', name: 'new-server', ownerId: 'u1' } as Server);
    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
    expect(useServerStore.getState().servers).toEqual([]);
  });

  // F38 round 8: the contract covers EVERY await. selectServer never rejects (it
  // guards internally), so a boundary during createServer's nested selectServer
  // await would otherwise let the mutation FULFILL.
  it('createServer superseded during its nested selectServer await still rejects', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null });
    vi.mocked(client.apiCreateServer).mockResolvedValue({ id: 's-new', name: 'X', ownerId: 'u1' } as Server);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const dChannels = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dChannels.promise);

    const p = useServerStore.getState().createServer('X');
    await new Promise((r) => setTimeout(r, 0)); // reach the held selectServer await
    invalidateSession(); // boundary during the SECOND await
    dChannels.resolve([]);

    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
  });

  // F38 round 8: the failure arm honors the same contract -- a stale rejection is
  // the superseded outcome, not the raw transport error.
  it('leaveServer rejecting after the session ends surfaces SessionSupersededError, not the raw error', async () => {
    const d = deferred<void>();
    vi.mocked(client.apiLeaveServer).mockReturnValue(d.promise);
    const p = useServerStore.getState().leaveServer('s1');
    invalidateSession();
    d.reject(new Error('boom'));
    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
  });

  it('deleteServer rejecting after the session ends surfaces SessionSupersededError, not the raw error', async () => {
    const d = deferred<void>();
    vi.mocked(client.apiDeleteServer).mockReturnValue(d.promise);
    const p = useServerStore.getState().deleteServer('s1');
    invalidateSession();
    d.reject(new Error('boom'));
    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
  });

  // F38 round 19: same-session request/resource ownership in the core stores.
  it('concurrent selectServer calls leave the LAST selection with ITS channels', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dA = deferred<Channel[]>();
    const dB = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels)
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dB.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });

    const pA = useServerStore.getState().selectServer('srv-a');
    const pB = useServerStore.getState().selectServer('srv-b');
    dB.resolve([{ id: 'chan-b', name: 'b', serverId: 'srv-b', position: 0 } as Channel]);
    await pB;
    dA.resolve([{ id: 'chan-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel]); // older settles last
    await pA;

    expect(useServerStore.getState().selectedServerId).toBe('srv-b');
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['chan-b']); // never A's
    useServerStore.getState().reset();
  });

  it('a channel created for a previous server is not appended or selected after switching', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 'srv-a', channels: [], selectedChannelId: null });
    const d = deferred<Channel>();
    vi.mocked(client.apiCreateChannel).mockReturnValue(d.promise);

    const p = useServerStore.getState().createChannel('srv-a', 'general');
    useServerStore.setState({ selectedServerId: 'srv-b', channels: [], selectedChannelId: null }); // user switches
    d.resolve({ id: 'chan-a', name: 'general', serverId: 'srv-a', position: 0 } as Channel);
    await p; // resolves normally: the create succeeded, on server A

    expect(useServerStore.getState().channels).toEqual([]); // not appended under B
    expect(useServerStore.getState().selectedChannelId).toBeNull(); // not selected under B
    useServerStore.getState().reset();
  });

  it('an older fetchDMs response cannot overwrite a newer snapshot', async () => {
    useDMStore.setState({ dmChannels: [] });
    const dOld = deferred<DMChannel[]>();
    const dNew = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs)
      .mockReturnValueOnce(dOld.promise)
      .mockReturnValueOnce(dNew.promise);

    const pOld = useDMStore.getState().fetchDMs();
    const pNew = useDMStore.getState().fetchDMs();
    dNew.resolve([{ id: 'dm-new' } as DMChannel]);
    await pNew;
    dOld.resolve([{ id: 'dm-old' } as DMChannel]); // older settles last
    await pOld;

    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toEqual(['dm-new']);
    useDMStore.getState().reset();
  });

  // F38 round 20: empty scope invalidates an active selection; lineages are
  // per-resource; and mutations/realtime commits supersede in-flight snapshots.
  it('a held selectServer settling after entering DM scope installs nothing', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [], selectedChannelId: null });
    const d = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(d.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });

    const p = useServerStore.getState().selectServer('srv-a'); // held
    useServerStore.getState().clearServerSelection(); // user opens the DM view
    d.resolve([{ id: 'chan-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel]);
    await p;

    expect(useServerStore.getState().selectedServerId).toBeNull();
    expect(useServerStore.getState().channels).toEqual([]); // nothing installed
    expect(useServerStore.getState().selectedChannelId).toBeNull(); // nothing to shadow the DM
    useServerStore.getState().reset();
  });

  it('a later fetchServers does not strand an active selectServer loading state', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dChan = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dChan.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);

    const pSel = useServerStore.getState().selectServer('srv-a'); // channel fetch held
    const pList = useServerStore.getState().fetchServers(); // different resource
    dList.resolve([{ id: 'srv-a', name: 'A' } as Server]);
    await pList;
    dChan.resolve([{ id: 'chan-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel]);
    await pSel;

    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['chan-a']); // committed
    expect(useServerStore.getState().isLoadingChannels).toBe(false); // not stranded
    expect(useServerStore.getState().isLoadingServers).toBe(false);
    useServerStore.getState().reset();
  });

  it('a realtime-created channel survives an older channels snapshot', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const d = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(d.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });

    const p = useServerStore.getState().selectServer('srv-a'); // snapshot held
    useServerStore.getState().addChannel({ id: 'chan-rt', name: 'rt', serverId: 'srv-a', position: 5 } as Channel);
    d.resolve([{ id: 'chan-old', name: 'old', serverId: 'srv-a', position: 0 } as Channel]); // pre-create snapshot
    await p;

    const ids = useServerStore.getState().channels.map((c) => c.id);
    expect(ids).toContain('chan-rt'); // not erased by the stale snapshot
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    useServerStore.getState().reset();
  });

  it('a newly created DM survives an older fetchDMs snapshot', async () => {
    useDMStore.setState({ dmChannels: [] });
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    vi.mocked(client.apiCreateDM).mockResolvedValue({ id: 'dm-new' } as DMChannel);

    const pFetch = useDMStore.getState().fetchDMs(); // snapshot held
    await useDMStore.getState().createDM(['u2']); // commits + supersedes
    dFetch.resolve([]); // pre-create snapshot settles late
    await pFetch;

    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toContain('dm-new');
    useDMStore.getState().reset();
  });

  it('a realtime DM_CREATE survives an older fetchDMs snapshot', async () => {
    useDMStore.setState({ dmChannels: [] });
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);

    const pFetch = useDMStore.getState().fetchDMs(); // snapshot held
    useDMStore.getState().addDM({ id: 'dm-rt' } as DMChannel); // realtime commit
    dFetch.resolve([]);
    await pFetch;

    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toContain('dm-rt');
    useDMStore.getState().reset();
  });

  it('a successfully closed DM is not resurrected by an older snapshot', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-x' } as DMChannel] });
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    vi.mocked(client.apiCloseDM).mockResolvedValue(undefined);

    const pFetch = useDMStore.getState().fetchDMs(); // pre-close snapshot held
    await useDMStore.getState().closeDM('dm-x'); // commits + supersedes
    dFetch.resolve([{ id: 'dm-x' } as DMChannel]); // stale snapshot with the closed DM
    await pFetch;

    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).not.toContain('dm-x');
    useDMStore.getState().reset();
  });

  it('setChannelPositions commits nothing for a server that is no longer selected', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 'srv-b', channels: [{ id: 'chan-b', name: 'b', serverId: 'srv-b', position: 0 } as Channel] });
    useServerStore.getState().setChannelPositions('srv-a', [{ id: 'chan-b', position: 5 }]); // old-server reorder/revert
    expect(useServerStore.getState().channels[0].position).toBe(0); // untouched
    useServerStore.getState().reset();
  });

  it('a reorder commit preserves a channel created by realtime mid-flight', async () => {
    useServerStore.setState({
      servers: [], selectedServerId: 'srv-a',
      channels: [
        { id: 'c1', name: 'one', serverId: 'srv-a', position: 0 } as Channel,
        { id: 'c2', name: 'two', serverId: 'srv-a', position: 1 } as Channel,
      ],
    });
    // A realtime channel arrives AFTER the reorder was computed...
    useServerStore.getState().addChannel({ id: 'c-rt', name: 'rt', serverId: 'srv-a', position: 2 } as Channel);
    // ...then the (older-snapshot-based) reorder commits functionally.
    useServerStore.getState().setChannelPositions('srv-a', [
      { id: 'c2', position: 0 }, { id: 'c1', position: 1 },
    ]);
    const ids = useServerStore.getState().channels.map((c) => c.id);
    expect(ids).toContain('c-rt'); // NOT erased by the reorder
    expect(ids.slice(0, 2)).toEqual(['c2', 'c1']); // positions applied
    useServerStore.getState().reset();
  });

  it('createChannel commit survives an older selectServer snapshot', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dSnap = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dSnap.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pSel = useServerStore.getState().selectServer('srv-a'); // snapshot held
    vi.mocked(client.apiCreateChannel).mockResolvedValue({ id: 'c-new', name: 'new', serverId: 'srv-a', position: 9 } as Channel);
    await useServerStore.getState().createChannel('srv-a', 'new'); // commits + claims
    dSnap.resolve([{ id: 'c-old', name: 'old', serverId: 'srv-a', position: 0 } as Channel]); // pre-create snapshot
    await pSel;
    expect(useServerStore.getState().channels.map((c) => c.id)).toContain('c-new'); // not erased
    useServerStore.getState().reset();
  });

  it('a realtime remove while the list is cleared still supersedes the in-flight snapshot', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dSnap = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dSnap.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pSel = useServerStore.getState().selectServer('srv-a'); // clears list; snapshot held
    useServerStore.getState().removeChannel('c-dead'); // realtime delete; id not locally present
    dSnap.resolve([{ id: 'c-dead', name: 'dead', serverId: 'srv-a', position: 0 } as Channel]); // stale snapshot with it
    await pSel;
    expect(useServerStore.getState().channels.map((c) => c.id)).not.toContain('c-dead'); // no stale return
    expect(useServerStore.getState().isLoadingChannels).toBe(false); // loading settled
    useServerStore.getState().reset();
  });

  it('entering DM scope settles a superseded channel fetch loading flag', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    vi.mocked(client.apiGetChannels).mockReturnValue(new Promise(() => {})); // held forever
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    void useServerStore.getState().selectServer('srv-a'); // loading true, fetch held
    expect(useServerStore.getState().isLoadingChannels).toBe(true);
    useServerStore.getState().clearServerSelection();
    expect(useServerStore.getState().isLoadingChannels).toBe(false); // not stranded
    useServerStore.getState().reset();
  });

  it('a DM fetch reconciles an overlapping commit and settles its own loading', async () => {
    useDMStore.setState({ dmChannels: [], isLoading: false });
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    const pFetch = useDMStore.getState().fetchDMs();
    expect(useDMStore.getState().isLoading).toBe(true);
    useDMStore.getState().addDM({ id: 'dm-rt2' } as DMChannel); // journaled, not discarding
    dFetch.resolve([{ id: 'dm-other' } as DMChannel]); // the snapshot's unaffected row
    await pFetch;
    const ids = useDMStore.getState().dmChannels.map((d2) => d2.id);
    expect(ids).toContain('dm-rt2'); // the commit survived
    expect(ids).toContain('dm-other'); // AND the snapshot's rows survived -- reconciliation
    expect(useDMStore.getState().isLoading).toBe(false); // the fetch settles its own loading
    useDMStore.getState().reset();
  });

  it('a same-ID DM commit still supersedes an older snapshot', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-x2' } as DMChannel] });
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    const pFetch = useDMStore.getState().fetchDMs(); // held
    useDMStore.getState().addDM({ id: 'dm-x2' } as DMChannel); // same-ID (not locally novel)
    dFetch.resolve([]); // stale empty snapshot
    await pFetch;
    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toContain('dm-x2'); // not replaced
    useDMStore.getState().reset();
  });

  it('a removed server is not resurrected by an older fetchServers snapshot', async () => {
    useServerStore.setState({ servers: [{ id: 'srv-x', name: 'X', ownerId: 'u1' } as Server], selectedServerId: 'srv-x', channels: [] });
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    const pList = useServerStore.getState().fetchServers(); // pre-removal snapshot held
    useServerStore.getState().removeServer('srv-x'); // commits + claims
    dList.resolve([{ id: 'srv-x', name: 'X', ownerId: 'u1' } as Server]); // stale snapshot with it
    await pList;
    expect(useServerStore.getState().servers.map((sv) => sv.id)).not.toContain('srv-x');
    useServerStore.getState().reset();
  });

  // F38 round 22: reconciliation, not amnesia -- a fetch overlapped by mutations
  // commits its snapshot WITH them re-applied, preserving unaffected rows.
  it('a channels fetch reconciles a mid-flight realtime create, keeping snapshot rows', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const d = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(d.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const p = useServerStore.getState().selectServer('srv-a'); // snapshot held
    useServerStore.getState().addChannel({ id: 'c-rt', name: 'rt', serverId: 'srv-a', position: 9 } as Channel);
    d.resolve([{ id: 'c-snap', name: 'snap', serverId: 'srv-a', position: 0 } as Channel]);
    await p;
    const ids = useServerStore.getState().channels.map((c) => c.id);
    expect(ids).toContain('c-rt'); // the mutation survived
    expect(ids).toContain('c-snap'); // AND the snapshot's unaffected row survived
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    useServerStore.getState().reset();
  });

  it('a servers fetch reconciles mid-flight removal and update, keeping unaffected rows', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-dead', name: 'Dead', ownerId: 'u1' } as Server],
      selectedServerId: null, channels: [],
    });
    const d = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(d.promise);
    const p = useServerStore.getState().fetchServers(); // snapshot held
    useServerStore.getState().removeServer('srv-dead');
    useServerStore.getState().updateServer({ id: 'srv-b', name: 'B-renamed' } as Server);
    d.resolve([
      { id: 'srv-dead', name: 'Dead', ownerId: 'u1' } as Server,
      { id: 'srv-b', name: 'B', ownerId: 'u1' } as Server,
      { id: 'srv-c', name: 'C', ownerId: 'u1' } as Server,
    ]);
    await p;
    const byId = new Map(useServerStore.getState().servers.map((sv) => [sv.id, sv]));
    expect(byId.has('srv-dead')).toBe(false); // removal applied to the snapshot
    expect(byId.get('srv-b')?.name).toBe('B-renamed'); // update applied
    expect(byId.has('srv-c')).toBe(true); // unaffected row preserved
    useServerStore.getState().reset();
  });

  it('an event for another joined server does not disturb the selected server fetch', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const d = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(d.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const p = useServerStore.getState().selectServer('srv-a'); // snapshot held
    // Channel events belonging to ANOTHER joined server arrive mid-flight. The
    // create is the observable one: without the scope check its upsert INSERTS
    // the foreign channel into the selected server's list (immediately and via
    // the journal at reconcile time). The update's merge-if-present apply is
    // structurally inert for a foreign id but must not disturb the fetch either.
    useServerStore.getState().addChannel({ id: 'c-x', name: 'x', serverId: 'srv-other', position: 0 } as Channel);
    useServerStore.getState().updateChannel({ id: 'c-x', name: 'x2', serverId: 'srv-other', position: 0 } as Channel);
    expect(useServerStore.getState().channels.map((c) => c.id)).not.toContain('c-x');
    d.resolve([{ id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel]);
    await p;
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a']); // fully committed, unpolluted
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    useServerStore.getState().reset();
  });

  it('removing the selected server barriers its held channel fetch', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-a', name: 'A', ownerId: 'u1' } as Server],
      selectedServerId: null, channels: [],
    });
    const d = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(d.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const p = useServerStore.getState().selectServer('srv-a'); // channel fetch held
    useServerStore.getState().removeServer('srv-a'); // kicked/banned/deleted
    d.resolve([{ id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel]);
    await p;
    expect(useServerStore.getState().channels).toEqual([]); // nothing repopulated
    expect(useServerStore.getState().selectedServerId).toBeNull();
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    useServerStore.getState().reset();
  });

  it('createChannel does not duplicate a WebSocket-first creation', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 'srv-a', channels: [] });
    const chan = { id: 'c-new', name: 'new', serverId: 'srv-a', position: 0 } as Channel;
    useServerStore.getState().addChannel(chan); // CHANNEL_CREATE broadcast lands first
    vi.mocked(client.apiCreateChannel).mockResolvedValue(chan);
    await useServerStore.getState().createChannel('srv-a', 'new'); // HTTP response second
    const ids = useServerStore.getState().channels.map((c) => c.id);
    expect(ids).toEqual(['c-new']); // upserted, not duplicated
    useServerStore.getState().reset();
  });

  it('a same-ID realtime DM upserts the fresh payload over the stale object', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-u', recipients: [] } as never] });
    useDMStore.getState().addDM({ id: 'dm-u', recipients: [{ id: 'u9', username: 'fresh' }] } as never);
    const dm = useDMStore.getState().dmChannels.find((d2) => d2.id === 'dm-u');
    expect(dm?.recipients?.[0]?.username).toBe('fresh'); // replaced, not retained stale
    useDMStore.getState().reset();
  });

  // F38 round 23: ownership covers failure and lifecycle commits; selection is
  // reconciled; gap retries; whole-object events merge; deletions tombstone;
  // reset barriers lineage-owned requests.
  it('an older server-fetch failure does not overwrite a newer fetch success', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 'srv-ok', channels: [] });
    const d1 = deferred<Server[]>();
    const d2 = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const p1 = useServerStore.getState().fetchServers(); // older, will FAIL
    const p2 = useServerStore.getState().fetchServers(); // newer, will succeed
    d2.resolve([{ id: 'srv-ok', name: 'OK', ownerId: 'u1' } as Server]);
    await p2;
    d1.reject(new Error('network'));
    await p1;
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-ok']);
    expect(useServerStore.getState().error).toBeNull(); // stale failure published nothing
    expect(useServerStore.getState().isLoadingServers).toBe(false);
    useServerStore.getState().reset();
  });

  it('a superseded auto-selection failure does not clear the newer selection spinner', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dList = deferred<Server[]>();
    const dAuto = deferred<Channel[]>();
    const dSel = deferred<Channel[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    vi.mocked(client.apiGetChannels).mockReturnValueOnce(dAuto.promise).mockReturnValueOnce(dSel.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pF = useServerStore.getState().fetchServers();
    dList.resolve([{ id: 'srv-1', name: 'One', ownerId: 'u1' } as Server]); // auto-select srv-1
    await Promise.resolve();
    await Promise.resolve(); // auto-select's channel fetch is now held on dAuto
    const pSel = useServerStore.getState().selectServer('srv-2'); // newer selection, held on dSel
    expect(useServerStore.getState().isLoadingChannels).toBe(true);
    dAuto.reject(new Error('network')); // the SUPERSEDED auto-selection fails
    await pF;
    expect(useServerStore.getState().isLoadingChannels).toBe(true); // newer spinner untouched
    dSel.resolve([{ id: 'c-2', name: 'two', serverId: 'srv-2', position: 0 } as Channel]);
    await pSel;
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-2']);
    useServerStore.getState().reset();
  });

  it('a refresh that supersedes a selection settles its loading and selection', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dSel = deferred<Channel[]>();
    const dRef = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValueOnce(dSel.promise).mockReturnValueOnce(dRef.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pSel = useServerStore.getState().selectServer('srv-a'); // spinner true, held
    const pRef = useServerStore.getState().refreshChannels('srv-a'); // SUPERSEDES the selection
    dRef.resolve([{ id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel]);
    await pRef;
    expect(useServerStore.getState().isLoadingChannels).toBe(false); // settled by the new owner
    expect(useServerStore.getState().selectedChannelId).toBe('c-a'); // selection assumed too
    dSel.resolve([{ id: 'c-old', name: 'old', serverId: 'srv-a', position: 0 } as Channel]);
    await pSel; // superseded: commits nothing
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a']);
    useServerStore.getState().reset();
  });

  it('an older selection fetch does not steal selection from a mid-flight creation', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dSel = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dSel.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const chan = { id: 'c-new', name: 'new', serverId: 'srv-a', position: 5 } as Channel;
    vi.mocked(client.apiCreateChannel).mockResolvedValue(chan);
    const pSel = useServerStore.getState().selectServer('srv-a'); // snapshot held
    await useServerStore.getState().createChannel('srv-a', 'new'); // selects c-new mid-flight
    expect(useServerStore.getState().selectedChannelId).toBe('c-new');
    dSel.resolve([{ id: 'c-first', name: 'first', serverId: 'srv-a', position: 0 } as Channel]);
    await pSel;
    const ids = useServerStore.getState().channels.map((c) => c.id);
    expect(ids).toContain('c-first'); // snapshot row committed
    expect(ids).toContain('c-new'); // creation reconciled in
    expect(useServerStore.getState().selectedChannelId).toBe('c-new'); // selection NOT reset to first
    useServerStore.getState().reset();
  });

  it('a journal-gap fetch retries with a fresh snapshot instead of keeping partial state', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-keep', name: 'Keep', ownerId: 'u1' } as Server],
      selectedServerId: 'srv-keep', channels: [],
    });
    const d1 = deferred<Server[]>();
    const d2 = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const pF = useServerStore.getState().fetchServers();
    for (let i = 0; i < 129; i += 1) {
      useServerStore.getState().updateServer({ id: 'srv-keep', name: `Keep-${i}` } as Server);
    } // 129 claims > JOURNAL_CAP: the held fetch's evidence is pruned
    d1.resolve([{ id: 'srv-stale', name: 'Stale', ownerId: 'u1' } as Server]); // unreconcilable
    await Promise.resolve();
    d2.resolve([{ id: 'srv-fresh', name: 'Fresh', ownerId: 'u1' } as Server]); // the retry's snapshot
    await pF;
    expect(vi.mocked(client.apiGetServers)).toHaveBeenCalledTimes(2); // it RETRIED
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-fresh']);
    expect(useServerStore.getState().isLoadingServers).toBe(false);
    useServerStore.getState().reset();
  });

  it('a whole-object same-ID event does not erase fresher snapshot fields', async () => {
    useDMStore.setState({ dmChannels: [], isLoading: false });
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    const pFetch = useDMStore.getState().fetchDMs();
    // DM_CREATE payload: whole object, SILENT on lastMessage
    useDMStore.getState().addDM({ id: 'dm-p', recipients: [{ id: 'u9', username: 'fresh' }] } as never);
    dFetch.resolve([
      { id: 'dm-p', recipients: [], lastMessage: { id: 'm1', content: 'preview' } } as never,
      { id: 'dm-q' } as never,
    ]);
    await pFetch;
    const dmP = useDMStore.getState().dmChannels.find((d2) => d2.id === 'dm-p') as never as {
      lastMessage?: { content: string }; recipients?: { username: string }[];
    };
    expect(dmP?.lastMessage?.content).toBe('preview'); // fresher snapshot field SURVIVED the replay
    expect(dmP?.recipients?.[0]?.username).toBe('fresh'); // event's own fields still won
    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toContain('dm-q');
    // Direct (non-replay) same-ID event after the commit: merge, not replace
    useDMStore.getState().addDM({ id: 'dm-p', recipients: [{ id: 'u9', username: 'fresher' }] } as never);
    const dmP2 = useDMStore.getState().dmChannels.find((d2) => d2.id === 'dm-p') as never as {
      lastMessage?: { content: string };
    };
    expect(dmP2?.lastMessage?.content).toBe('preview');
    useDMStore.getState().reset();
  });

  it('a channel deleted just before a fetch starts is not resurrected by its snapshot', async () => {
    useServerStore.setState({
      servers: [], selectedServerId: 'srv-a', selectedChannelId: 'c-a',
      channels: [
        { id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel,
        { id: 'c-b', name: 'b', serverId: 'srv-a', position: 1 } as Channel,
      ],
    });
    useServerStore.getState().removeChannel('c-b', 'srv-a'); // broadcast lands BEFORE the DB delete
    const dRef = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dRef.promise);
    const pRef = useServerStore.getState().refreshChannels('srv-a'); // starts AFTER the event
    dRef.resolve([
      { id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel,
      { id: 'c-b', name: 'b', serverId: 'srv-a', position: 1 } as Channel, // stale read: delete uncommitted
    ]);
    await pRef;
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a']); // tombstoned
    useServerStore.getState().reset();
  });

  it('a server removed just before a fetch starts is not resurrected by its snapshot', async () => {
    useServerStore.setState({
      servers: [
        { id: 'srv-keep', name: 'Keep', ownerId: 'u1' } as Server,
        { id: 'srv-x', name: 'X', ownerId: 'u1' } as Server,
      ],
      selectedServerId: 'srv-keep', channels: [],
    });
    useServerStore.getState().removeServer('srv-x'); // event first
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    const pList = useServerStore.getState().fetchServers(); // fetch starts after
    dList.resolve([
      { id: 'srv-keep', name: 'Keep', ownerId: 'u1' } as Server,
      { id: 'srv-x', name: 'X', ownerId: 'u1' } as Server, // stale read
    ]);
    await pList;
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-keep']);
    useServerStore.getState().reset();
  });

  it('a DM closed just before a fetch starts is not resurrected by its snapshot', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-z' } as DMChannel, { id: 'dm-y' } as DMChannel] });
    vi.mocked(client.apiCloseDM).mockResolvedValue(undefined as never);
    await useDMStore.getState().closeDM('dm-z'); // event first
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    const pFetch = useDMStore.getState().fetchDMs(); // fetch starts after
    dFetch.resolve([{ id: 'dm-z' } as DMChannel, { id: 'dm-y' } as DMChannel]); // stale read
    await pFetch;
    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toEqual(['dm-y']);
    useDMStore.getState().reset();
  });

  it('a re-asserted id clears its tombstone (recreate after delete is honored)', async () => {
    useServerStore.setState({
      servers: [], selectedServerId: 'srv-a', selectedChannelId: 'c-a',
      channels: [{ id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel],
    });
    useServerStore.getState().removeChannel('c-b', 'srv-a'); // tombstoned
    useServerStore.getState().addChannel({ id: 'c-b', name: 'b', serverId: 'srv-a', position: 1 } as Channel); // server re-asserts it
    const dRef = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dRef.promise);
    const pRef = useServerStore.getState().refreshChannels('srv-a');
    dRef.resolve([
      { id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel,
      { id: 'c-b', name: 'b', serverId: 'srv-a', position: 1 } as Channel,
    ]);
    await pRef;
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a', 'c-b']); // not suppressed
    useServerStore.getState().reset();
  });

  it('a channel deleted in ANOTHER server is tombstoned for a later selection of it', async () => {
    // Removals are subtractive, so they are NOT scope-gated: dropping a foreign
    // CHANNEL_DELETE would lose the tombstone that a later selection of that
    // server needs when its held fetch returns a pre-delete snapshot.
    useServerStore.setState({ servers: [], selectedServerId: 'srv-b', channels: [] });
    useServerStore.getState().removeChannel('c-x', 'srv-a'); // event for a server we are NOT viewing
    const dSel = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dSel.promise);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pSel = useServerStore.getState().selectServer('srv-a'); // now we select it
    dSel.resolve([
      { id: 'c-x', name: 'x', serverId: 'srv-a', position: 0 } as Channel, // stale read
      { id: 'c-a', name: 'a', serverId: 'srv-a', position: 1 } as Channel,
    ]);
    await pSel;
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a']); // no ghost
    expect(useServerStore.getState().selectedChannelId).toBe('c-a');
    useServerStore.getState().reset();
  });

  // F38 round 24: tombstones are race covers, not permanence; refresh cannot
  // claim a scope it does not hold; selection reconciles with the server list;
  // unselected removals do not churn; reset drops accumulated evidence.
  it('a stale wrong-server refresh does not strand the active selection', async () => {
    useServerStore.setState({ servers: [], selectedServerId: null, channels: [] });
    const dB = deferred<Channel[]>();
    // The non-once fallback exists for the MUTANT path (a refresh that wrongly
    // claims and fetches); correct code never consumes it -- a queued *Once here
    // would leak into the next test that touches this mock.
    vi.mocked(client.apiGetChannels).mockReturnValueOnce(dB.promise).mockResolvedValue([]);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pB = useServerStore.getState().selectServer('srv-b'); // active selection, held
    const pRef = useServerStore.getState().refreshChannels('srv-a'); // stale callback from the A era
    await pRef; // must NOT have claimed the lineage (scope-bails before startFetch)
    dB.resolve([{ id: 'c-b', name: 'b', serverId: 'srv-b', position: 0 } as Channel]);
    await pB;
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-b']); // B committed
    expect(useServerStore.getState().isLoadingChannels).toBe(false); // no permanent spinner
    useServerStore.getState().reset();
  });

  it('a DM tombstone retires after one fetch: a server-driven reopen becomes visible', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-r' } as DMChannel] });
    vi.mocked(client.apiCloseDM).mockResolvedValue(undefined as never);
    await useDMStore.getState().closeDM('dm-r'); // tombstoned
    const d1 = deferred<DMChannel[]>();
    const d2 = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const p1 = useDMStore.getState().fetchDMs();
    d1.resolve([{ id: 'dm-r' } as DMChannel]); // race-window read: filtered once
    await p1;
    expect(useDMStore.getState().dmChannels).toEqual([]);
    const p2 = useDMStore.getState().fetchDMs(); // the other side reopened it server-side
    d2.resolve([{ id: 'dm-r' } as DMChannel]);
    await p2;
    expect(useDMStore.getState().dmChannels.map((d3) => d3.id)).toEqual(['dm-r']); // NOT suppressed forever
    useDMStore.getState().reset();
  });

  it('reset clears DM tombstones: one account cannot hide a shared DM from the next', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-shared' } as DMChannel] });
    vi.mocked(client.apiCloseDM).mockResolvedValue(undefined as never);
    await useDMStore.getState().closeDM('dm-shared'); // account A closes it
    useDMStore.getState().reset(); // logout / account switch
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    const pFetch = useDMStore.getState().fetchDMs(); // account B's first fetch
    dFetch.resolve([{ id: 'dm-shared' } as DMChannel]);
    await pFetch;
    expect(useDMStore.getState().dmChannels.map((d2) => d2.id)).toEqual(['dm-shared']); // visible to B
    useDMStore.getState().reset();
  });

  it('reset clears server tombstones too', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-t', name: 'T', ownerId: 'u1' } as Server],
      selectedServerId: null, channels: [],
    });
    useServerStore.getState().removeServer('srv-t'); // tombstoned
    useServerStore.getState().reset();
    useServerStore.setState({ selectedServerId: 'srv-t' }); // avoid the auto-select branch
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    const pList = useServerStore.getState().fetchServers();
    dList.resolve([{ id: 'srv-t', name: 'T', ownerId: 'u1' } as Server]);
    await pList;
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-t']);
    useServerStore.getState().reset();
  });

  it('a rejoin is visible immediately and survives the next fetch', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-r', name: 'R', ownerId: 'u1' } as Server],
      selectedServerId: null, channels: [],
    });
    useServerStore.getState().removeServer('srv-r'); // kicked/left -- tombstoned
    expect(useServerStore.getState().servers).toEqual([]);
    useServerStore.getState().addServer({ id: 'srv-r', name: 'R', ownerId: 'u1' } as Server); // join response
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-r']); // IMMEDIATE
    useServerStore.setState({ selectedServerId: 'srv-r' }); // avoid the auto-select branch
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    const pList = useServerStore.getState().fetchServers();
    dList.resolve([{ id: 'srv-r', name: 'R', ownerId: 'u1' } as Server]);
    await pList;
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-r']); // not filtered back out
    useServerStore.getState().reset();
  });

  it('a stale channel update does not clear a deletion tombstone', async () => {
    useServerStore.setState({
      servers: [], selectedServerId: 'srv-a', selectedChannelId: 'c-a',
      channels: [{ id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel],
    });
    useServerStore.getState().removeChannel('c-dead', 'srv-a'); // tombstoned
    const dRef = deferred<Channel[]>();
    vi.mocked(client.apiGetChannels).mockReturnValue(dRef.promise);
    const pRef = useServerStore.getState().refreshChannels('srv-a'); // fetch starts after the delete
    // Delayed update, sent before the deletion, delivered after: target is absent.
    useServerStore.getState().updateChannel({ id: 'c-dead', name: 'zombie', serverId: 'srv-a', position: 9 } as Channel);
    dRef.resolve([
      { id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel,
      { id: 'c-dead', name: 'dead', serverId: 'srv-a', position: 9 } as Channel, // pre-delete read
    ]);
    await pRef;
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a']); // no resurrection
    useServerStore.getState().reset();
  });

  it('a stale server update does not clear a deletion tombstone', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-keep', name: 'Keep', ownerId: 'u1' } as Server],
      selectedServerId: 'srv-keep', channels: [],
    });
    useServerStore.getState().removeServer('srv-dead'); // tombstoned (absent locally)
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    const pList = useServerStore.getState().fetchServers();
    useServerStore.getState().updateServer({ id: 'srv-dead', name: 'zombie' } as Server); // stale no-op
    dList.resolve([
      { id: 'srv-keep', name: 'Keep', ownerId: 'u1' } as Server,
      { id: 'srv-dead', name: 'Dead', ownerId: 'u1' } as Server, // pre-delete read
    ]);
    await pList;
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toEqual(['srv-keep']);
    useServerStore.getState().reset();
  });

  it('removing an unselected server does not churn the current view', async () => {
    useServerStore.setState({
      servers: [
        { id: 'srv-a', name: 'A', ownerId: 'u1' } as Server,
        { id: 'srv-other', name: 'O', ownerId: 'u1' } as Server,
      ],
      selectedServerId: 'srv-a', selectedChannelId: 'c-a',
      channels: [{ id: 'c-a', name: 'a', serverId: 'srv-a', position: 0 } as Channel],
    });
    vi.mocked(client.apiGetChannels).mockClear();
    useServerStore.getState().removeServer('srv-other');
    expect(useServerStore.getState().selectedServerId).toBe('srv-a'); // untouched
    expect(useServerStore.getState().selectedChannelId).toBe('c-a'); // not yanked to first
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-a']); // not cleared
    expect(useServerStore.getState().isLoadingChannels).toBe(false); // no refetch spinner
    expect(vi.mocked(client.apiGetChannels)).not.toHaveBeenCalled(); // no reselect fetch
    useServerStore.getState().reset();
  });

  it('a server-list commit omitting the selected server clears the dangling selection', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-gone', name: 'Gone', ownerId: 'u1' } as Server],
      selectedServerId: 'srv-gone', selectedChannelId: 'c-g',
      channels: [{ id: 'c-g', name: 'g', serverId: 'srv-gone', position: 0 } as Channel],
    });
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    const pList = useServerStore.getState().fetchServers();
    dList.resolve([]); // kicked while away: authoritative list no longer has it
    await pList;
    expect(useServerStore.getState().selectedServerId).toBeNull(); // no dangle
    expect(useServerStore.getState().selectedChannelId).toBeNull();
    expect(useServerStore.getState().channels).toEqual([]);
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    useServerStore.getState().reset();
  });

  it('a server-list commit omitting the selected server moves selection to the first available', async () => {
    useServerStore.setState({
      servers: [{ id: 'srv-gone', name: 'Gone', ownerId: 'u1' } as Server],
      selectedServerId: 'srv-gone', selectedChannelId: 'c-g',
      channels: [{ id: 'c-g', name: 'g', serverId: 'srv-gone', position: 0 } as Channel],
    });
    const dList = deferred<Server[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    vi.mocked(client.apiGetChannels).mockResolvedValue([
      { id: 'c-k', name: 'k', serverId: 'srv-keep', position: 0 } as Channel,
    ]);
    vi.mocked(client.apiGetMemberPermissions).mockResolvedValue({ permissions: 0 });
    const pList = useServerStore.getState().fetchServers();
    dList.resolve([{ id: 'srv-keep', name: 'Keep', ownerId: 'u1' } as Server]);
    await pList;
    expect(useServerStore.getState().selectedServerId).toBe('srv-keep'); // reselected
    await Promise.resolve();
    await Promise.resolve(); // let the fired selectServer commit
    expect(useServerStore.getState().channels.map((c) => c.id)).toEqual(['c-k']);
    expect(useServerStore.getState().isLoadingChannels).toBe(false);
    useServerStore.getState().reset();
  });

  it('reset invalidates lineage-owned requests: a held fetch cannot repopulate the cleared store', async () => {
    useServerStore.setState({ servers: [], selectedServerId: 'srv-keep', channels: [] });
    useDMStore.setState({ dmChannels: [] });
    const dList = deferred<Server[]>();
    const dDMs = deferred<DMChannel[]>();
    vi.mocked(client.apiGetServers).mockReturnValue(dList.promise);
    vi.mocked(client.apiGetDMs).mockReturnValue(dDMs.promise);
    const pList = useServerStore.getState().fetchServers();
    const pDMs = useDMStore.getState().fetchDMs();
    useServerStore.getState().reset(); // same auth generation -- reset alone must suffice
    useDMStore.getState().reset();
    dList.resolve([{ id: 'srv-z', name: 'Z', ownerId: 'u1' } as Server]);
    dDMs.resolve([{ id: 'dm-z' } as DMChannel]);
    await Promise.all([pList, pDMs]);
    expect(useServerStore.getState().servers).toEqual([]);
    expect(useDMStore.getState().dmChannels).toEqual([]);
    expect(useServerStore.getState().isLoadingServers).toBe(false);
    expect(useDMStore.getState().isLoading).toBe(false);
  });

  // F38 round 11: overlapping startup validations share one generation (React
  // StrictMode double-effects), so recency must order them -- an OLDER validation
  // failing after a newer one succeeded must not log the validated session out.
  it('an older loadFromStorage failure cannot log out a newer successful validation', async () => {
    storage.setItem('accessToken', 'valid-token-aaaa');
    storage.setItem('refreshToken', 'valid-token-bbbb');
    storage.setItem('user', JSON.stringify({ id: 'u1', username: 'alice' }));
    const dOld = deferred<{ id: string; username: string }>();
    const dNew = deferred<{ id: string; username: string }>();
    vi.mocked(client.apiGetMe)
      .mockReturnValueOnce(dOld.promise as never)
      .mockReturnValueOnce(dNew.promise as never);

    const pOld = useAuthStore.getState().loadFromStorage();
    const pNew = useAuthStore.getState().loadFromStorage();
    dNew.resolve({ id: 'u1', username: 'alice' }); // the NEWER validation succeeds
    await pNew;
    dOld.reject(new Error('expired')); // the OLDER one then fails
    await pOld;

    expect(useAuthStore.getState().isAuthenticated).toBe(true); // not logged out
    expect(useAuthStore.getState().user).toEqual({ id: 'u1', username: 'alice' });
    useAuthStore.setState({ user: null, isAuthenticated: false });
    storage.removeItem('accessToken'); storage.removeItem('refreshToken'); storage.removeItem('user');
  });

  // F38 round 11: closeDM is fire-and-forget at every call site, so it must be
  // TOTAL -- logout aborts its in-flight request, and that rejection must not
  // surface as an unhandled rejection mid-teardown.
  it('closeDM never rejects: a teardown-aborted close resolves silently', async () => {
    useDMStore.setState({ error: null });
    const d = deferred<void>();
    vi.mocked(client.apiCloseDM).mockReturnValue(d.promise);
    const p = useDMStore.getState().closeDM('dm1');
    invalidateSession(); // logout begins; the request is then aborted
    d.reject(new Error('canceled'));
    await expect(p).resolves.toBeUndefined();
    expect(useDMStore.getState().error).toBeNull(); // not this session's concern
  });

  it('closeDM surfaces a same-session failure as a toast instead of rejecting', async () => {
    useToastStore.getState().clear();
    const d = deferred<void>();
    vi.mocked(client.apiCloseDM).mockReturnValue(d.promise);
    const p = useDMStore.getState().closeDM('dm1');
    d.reject(new Error('boom'));
    await expect(p).resolves.toBeUndefined();
    // The app-level ToastContainer renders these; dmStore.error is rendered nowhere.
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Failed to close conversation'
    );
    useToastStore.getState().clear();
  });

  // F38 round 13: EVERY loadFromStorage invocation claims recency at entry -- and
  // an OWNING no-token invocation must also clear the provisional IN-MEMORY
  // identity an earlier overlapped validation optimistically published. "No
  // session" must be true in memory, not just in persistent storage.
  it('an owning no-token loadFromStorage clears the superseded provisional identity', async () => {
    storage.setItem('accessToken', 'valid-token-aaaa');
    storage.setItem('refreshToken', 'valid-token-bbbb');
    storage.setItem('user', JSON.stringify({ id: 'u1', username: 'alice' }));
    const dOld = deferred<{ id: string; username: string }>();
    vi.mocked(client.apiGetMe).mockReturnValueOnce(dOld.promise as never);

    const pOld = useAuthStore.getState().loadFromStorage(); // publishes provisional A, then holds
    expect(useAuthStore.getState().isAuthenticated).toBe(true); // provisional identity in memory
    storage.removeItem('accessToken');
    storage.removeItem('refreshToken');
    const genBefore = captureSessionGeneration();
    const ownedNoToken = await useAuthStore.getState().loadFromStorage(); // no-token path
    expect(ownedNoToken).toBe(true); // it owned the (no-session) outcome
    // The owner ENDS the provisional session -- full logout, not a field clear:
    // the generation advances (so an in-flight provisional refresh can no longer
    // restore the old credentials), and memory is unauthenticated.
    expect(isSessionGenerationCurrent(genBefore)).toBe(false); // identity ended
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().accessToken).toBeNull();

    const resetsBefore = vi.mocked(resetAllStores).mock.calls.length;
    dOld.reject(new Error('expired')); // the superseded validation then fails
    expect(await pOld).toBe(false); // it did not own the outcome
    // ...and it did not commit anything (no logout ran for it).
    expect(vi.mocked(resetAllStores).mock.calls.length).toBe(resetsBefore);
  });

  // F38 round 14: an OWNING invocation failing unexpectedly must not complete
  // startup with a provisional identity still authenticated -- it tears down.
  it('an owning startup failure ends the provisional identity safely', async () => {
    // Provisional identity from an earlier overlapped validation.
    useAuthStore.setState({ user: { id: 'u-a' } as never, isAuthenticated: true });
    const getItemSpy = vi.spyOn(storage, 'getItem').mockImplementationOnce(() => {
      throw new Error('storage exploded');
    });

    const owned = await useAuthStore.getState().loadFromStorage();

    expect(owned).toBe(true); // the owner reports its (torn-down) outcome
    expect(useAuthStore.getState().isAuthenticated).toBe(false); // not left authenticated
    expect(useAuthStore.getState().user).toBeNull();
    getItemSpy.mockRestore();
  });

  // F38 round 13: loadFromStorage is TOTAL -- it never rejects, because startup
  // ownership gates isInitialized and App deliberately has no catch-belt.
  it('loadFromStorage resolves a boolean even when validation throws synchronously', async () => {
    storage.setItem('accessToken', 'valid-token-aaaa');
    storage.setItem('refreshToken', 'valid-token-bbbb');
    vi.mocked(client.apiGetMe).mockImplementationOnce(() => {
      throw new Error('sync explosion');
    });
    const owned = await useAuthStore.getState().loadFromStorage();
    expect(typeof owned).toBe('boolean');
    useAuthStore.setState({ user: null, isAuthenticated: false });
    storage.removeItem('accessToken'); storage.removeItem('refreshToken'); storage.removeItem('user');
  });

  // F38 round 12: startup gating consumes the owned-boolean -- a superseded call
  // resolves false so App does not mount protected routing on ITS settle.
  it('a superseded loadFromStorage resolves false; the owning one resolves true', async () => {
    storage.setItem('accessToken', 'valid-token-aaaa');
    storage.setItem('refreshToken', 'valid-token-bbbb');
    const dOld = deferred<{ id: string; username: string }>();
    const dNew = deferred<{ id: string; username: string }>();
    vi.mocked(client.apiGetMe)
      .mockReturnValueOnce(dOld.promise as never)
      .mockReturnValueOnce(dNew.promise as never);

    const pOld = useAuthStore.getState().loadFromStorage();
    const pNew = useAuthStore.getState().loadFromStorage();
    dOld.resolve({ id: 'u1', username: 'alice' }); // the OLDER settles first
    expect(await pOld).toBe(false); // superseded: must not complete startup
    dNew.resolve({ id: 'u1', username: 'alice' });
    expect(await pNew).toBe(true); // the owner completes startup
    useAuthStore.setState({ user: null, isAuthenticated: false });
    storage.removeItem('accessToken'); storage.removeItem('refreshToken'); storage.removeItem('user');
  });

  // F38 round 9: login must TEAR DOWN the superseded identity at entry -- clear the
  // old bearer token (so pending-window requests cannot commit the old account's
  // data under the new generation), abort in-flight transport, and reset every
  // per-user store (cached data must not survive into the new session).
  it('login tears down the previous identity at entry, before the request resolves', async () => {
    const d = deferred<LoginResponse>();
    vi.mocked(client.apiLogin).mockReturnValue(d.promise);

    const p = useAuthStore.getState().login('b@x.com', 'pw');
    // Teardown happens synchronously at entry -- the login request is still held.
    expect(client.clearTokens).toHaveBeenCalled();
    expect(client.abortInFlightRequests).toHaveBeenCalled();
    expect(resetAllStores).toHaveBeenCalled();

    d.resolve({ user: { id: 'u-b' }, accessToken: 'b', refreshToken: 'b' } as LoginResponse);
    await p;
  });

  it('register tears down the previous identity at entry, before the request resolves', async () => {
    const d = deferred<LoginResponse>();
    vi.mocked(client.apiRegister).mockReturnValue(d.promise);

    const p = useAuthStore.getState().register('bob', 'b@x.com', 'pw');
    expect(client.clearTokens).toHaveBeenCalled();
    expect(client.abortInFlightRequests).toHaveBeenCalled();
    expect(resetAllStores).toHaveBeenCalled();

    d.resolve({ user: { id: 'u-b' }, accessToken: 'b', refreshToken: 'b' } as LoginResponse);
    await p;
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

  it('a login response resolving after a newer identity boundary rejects and does not resurrect the session', async () => {
    useAuthStore.setState({ isAuthenticated: false, user: null });
    const d = deferred<LoginResponse>();
    vi.mocked(client.apiLogin).mockReturnValue(d.promise);
    const p = useAuthStore.getState().login('a@b.c', 'pw'); // invalidates + captures at entry
    invalidateSession(); // a newer boundary (concurrent login / logout) supersedes it
    d.resolve({ user: { id: 'u-old', username: 'old' }, accessToken: 'a', refreshToken: 'r' } as LoginResponse);
    // Rejects (not resolves) so the form's await throws and it does NOT navigate to /app.
    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('loadFromStorage validation resolving after a boundary does not repopulate the user', async () => {
    storage.setItem('accessToken', 'a'.repeat(20));
    storage.setItem('refreshToken', 'r'.repeat(20));
    storage.removeItem('user');
    const d = deferred<{ id: string; username: string }>();
    vi.mocked(client.apiGetMe).mockReturnValue(d.promise as never);
    const p = useAuthStore.getState().loadFromStorage();
    invalidateSession(); // logout / account replacement during validation
    d.resolve({ id: 'u-old', username: 'old' });
    await p;
    expect(useAuthStore.getState().user).toBeNull(); // stale validation did not repopulate
  });

  it('loadFromStorage validation failing after a boundary does not log out the newer session', async () => {
    storage.setItem('accessToken', 'a'.repeat(20));
    storage.setItem('refreshToken', 'r'.repeat(20));
    const logoutSpy = vi.spyOn(useAuthStore.getState(), 'logout');
    const d = deferred<never>();
    vi.mocked(client.apiGetMe).mockReturnValue(d.promise as never);
    const p = useAuthStore.getState().loadFromStorage();
    invalidateSession();
    d.reject(new Error('invalid token'));
    await p;
    expect(logoutSpy).not.toHaveBeenCalled(); // must not clobber a newer session
    logoutSpy.mockRestore();
  });

  it('register advances the session generation at entry (establishes a new identity)', () => {
    const g = captureSessionGeneration();
    vi.mocked(client.apiRegister).mockReturnValue(new Promise(() => {})); // hangs
    void useAuthStore.getState().register('u', 'a@b.c', 'pw');
    expect(isSessionGenerationCurrent(g)).toBe(false); // prior generation invalidated
  });

  it('a register response resolving after a newer boundary rejects and does not authenticate', async () => {
    useAuthStore.setState({ isAuthenticated: false, user: null });
    const d = deferred<LoginResponse>();
    vi.mocked(client.apiRegister).mockReturnValue(d.promise);
    const p = useAuthStore.getState().register('u', 'a@b.c', 'pw');
    invalidateSession(); // superseded during the request
    d.resolve({ user: { id: 'u-old', username: 'old' }, accessToken: 'a', refreshToken: 'r' } as LoginResponse);
    await expect(p).rejects.toBeInstanceOf(SessionSupersededError);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('commandStore.fetchCommands: a response after the session ends does not overwrite commands (same server id)', async () => {
    useCommandStore.setState({ commands: [], serverId: null });
    const d = deferred<ApplicationCommand[]>();
    vi.mocked(client.apiGetServerCommands).mockReturnValue(d.promise);
    useCommandStore.getState().fetchCommands('s1');
    invalidateSession(); // new account logs in, also on server s1 (same id)
    useCommandStore.setState({ serverId: 's1' });
    d.resolve([{ id: 'cmd-old' } as ApplicationCommand]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useCommandStore.getState().commands).toEqual([]); // stale fetch did not overwrite
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
