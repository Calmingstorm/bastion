import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DMChannel } from '../types';

// The handler-wiring block below drives PRODUCTION handlers into real stores;
// the API is mocked so tests control when each request settles.
vi.mock('../api/client', () => ({
  apiGetServers: vi.fn(),
  apiGetChannels: vi.fn(),
  apiGetDMs: vi.fn(),
  apiCloseDM: vi.fn(),
  apiGetReadStates: vi.fn(),
  apiAckChannel: vi.fn(),
  apiGetMemberPermissions: vi.fn(),
  apiGetMessages: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  abortInFlightRequests: vi.fn(),
}));

import * as client from '../api/client';
import { wsClient } from '../api/websocket';
import { resyncAfterReconnect, useWSStore } from './wsStore';
import { useServerStore } from './serverStore';
import { useDMStore } from './dmStore';
import { useMessageStore } from './messageStore';
import { useUnreadStore } from './unreadStore';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('resyncAfterReconnect', () => {
  beforeEach(() => {
    useServerStore.setState({ selectedChannelId: null });
    useDMStore.setState({ selectedDMId: null });
    vi.restoreAllMocks();
  });

  it('re-fetches the active channel in merge mode', () => {
    useServerStore.setState({ selectedChannelId: 'c1' });
    const fetchSpy = vi.spyOn(useMessageStore.getState(), 'fetchMessages').mockResolvedValue();
    vi.spyOn(useDMStore.getState(), 'fetchDMs').mockResolvedValue();
    vi.spyOn(useUnreadStore.getState(), 'fetchReadStates').mockResolvedValue();

    resyncAfterReconnect();

    // The reconnect wiring must pass merge=true, so the resync preserves history
    // and live changes instead of replacing them.
    expect(fetchSpy).toHaveBeenCalledWith('c1', undefined, true);
  });

  it('falls back to the selected DM when no server channel is active', () => {
    useDMStore.setState({ selectedDMId: 'd1' });
    const fetchSpy = vi.spyOn(useMessageStore.getState(), 'fetchMessages').mockResolvedValue();
    vi.spyOn(useDMStore.getState(), 'fetchDMs').mockResolvedValue();
    vi.spyOn(useUnreadStore.getState(), 'fetchReadStates').mockResolvedValue();

    resyncAfterReconnect();

    expect(fetchSpy).toHaveBeenCalledWith('d1', undefined, true);
  });
});

// F38 round 28 (review round 27): the MESSAGE_CREATE wiring itself is pinned --
// store-level tests that call actions directly do not prove the handler passes
// the right arguments in the right order. These capture the PRODUCTION handler
// registered by useWSStore.connect() and drive it with raw payloads.
describe('wsStore MESSAGE_CREATE production wiring', () => {
  const handlers: Record<string, (data: unknown) => void> = {};

  beforeEach(() => {
    vi.restoreAllMocks(); // the resync block's store-action spies must not leak in
    vi.spyOn(wsClient, 'on').mockImplementation(((ev: string, h: (d: unknown) => void) => {
      handlers[ev] = h;
    }) as never);
    vi.spyOn(wsClient, 'connect').mockImplementation(() => {});
    vi.spyOn(wsClient, 'disconnect').mockImplementation(() => {});
    useWSStore.getState().connect('test-token'); // registers the real handlers
    useServerStore.getState().reset();
    useDMStore.getState().reset();
    useUnreadStore.getState().reset();
  });

  afterEach(() => {
    useServerStore.getState().reset();
    useDMStore.getState().reset();
    useUnreadStore.getState().reset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('a message in a closed (unknown) DM asserts aliveness BEFORE the refetch it triggers', async () => {
    vi.mocked(client.apiCloseDM).mockResolvedValue(undefined as never);
    useDMStore.setState({ dmChannels: [{ id: 'dm-w' } as DMChannel] });
    await useDMStore.getState().closeDM('dm-w'); // tombstoned, removed locally
    expect(useDMStore.getState().dmChannels).toEqual([]);
    const dFetch = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dFetch.promise);
    handlers['MESSAGE_CREATE']({
      message: { id: 'm1', channelId: 'dm-w', content: 'hi', createdAt: '2026-07-14T12:00:00Z' },
    });
    expect(vi.mocked(client.apiGetDMs)).toHaveBeenCalled(); // unknown channel -> refetch
    dFetch.resolve([{ id: 'dm-w' } as DMChannel]); // authoritative reopened list
    await Promise.resolve();
    await Promise.resolve();
    // Visible: the handler cleared the tombstone BEFORE the fetch it fired.
    expect(useDMStore.getState().dmChannels.map((d) => d.id)).toEqual(['dm-w']);
  });

  it('a message in a KNOWN DM journals its aliveness so a deciding fetch cannot erase it', async () => {
    useDMStore.setState({ dmChannels: [{ id: 'dm-k' } as DMChannel] });
    const dDeciding = deferred<DMChannel[]>();
    vi.mocked(client.apiGetDMs).mockReturnValue(dDeciding.promise);
    const pFetch = useDMStore.getState().fetchDMs(); // any in-flight fetch (deciding/load)
    handlers['MESSAGE_CREATE']({
      message: { id: 'm2', channelId: 'dm-k', content: 'yo', createdAt: '2026-07-14T12:00:00Z' },
    });
    expect(vi.mocked(client.apiGetDMs)).toHaveBeenCalledTimes(1); // known -> no extra fetch
    dDeciding.resolve([]); // snapshot read before the reopen committed
    await pFetch;
    expect(useDMStore.getState().dmChannels.map((d) => d.id)).toEqual(['dm-k']); // journaled, not erased
  });

  it('passes the server-minted createdAt through to markUnread', () => {
    useUnreadStore.setState({
      readStates: {
        'ch-r': { userId: '', channelId: 'ch-r', lastMessageId: 'm9', lastReadAt: '2026-07-14T12:00:10Z', mentionCount: 0 },
      },
      unreadChannels: new Set(),
    });
    // Delayed pre-ack notification: its message predates the committed read.
    handlers['MESSAGE_CREATE']({
      message: { id: 'm5', channelId: 'ch-r', content: 'old', createdAt: '2026-07-14T12:00:05Z' },
    });
    expect(useUnreadStore.getState().isUnread('ch-r')).toBe(false); // dropped by the clock guard
    // A genuinely new message raises the flag.
    handlers['MESSAGE_CREATE']({
      message: { id: 'm10', channelId: 'ch-r', content: 'new', createdAt: '2026-07-14T12:00:15Z' },
    });
    expect(useUnreadStore.getState().isUnread('ch-r')).toBe(true);
  });

  it('does not mark the ACTIVE channel unread', () => {
    useServerStore.setState({ selectedChannelId: 'ch-a' });
    handlers['MESSAGE_CREATE']({
      message: { id: 'm3', channelId: 'ch-a', content: 'here', createdAt: '2026-07-14T12:00:00Z' },
    });
    expect(useUnreadStore.getState().isUnread('ch-a')).toBe(false);
  });

  it('prefers the non-overridable eventAt over a bot-backdated createdAt', () => {
    // Bots may backdate message.createdAt (a presentation timestamp). The
    // envelope's eventAt is the server's own emission time: a backdated mention
    // is still a post-acknowledgment EVENT and must raise the flag.
    useUnreadStore.setState({
      readStates: {
        'ch-b': { userId: '', channelId: 'ch-b', lastMessageId: 'm9', lastReadAt: '2026-07-14T12:00:10Z', mentionCount: 0 },
      },
      unreadChannels: new Set(),
    });
    handlers['MESSAGE_CREATE']({
      message: { id: 'm7', channelId: 'ch-b', content: 'sneaky', createdAt: '2026-07-14T11:00:00Z' }, // backdated
      eventAt: '2026-07-14T12:00:15Z', // the server actually emitted it AFTER the ack
    });
    expect(useUnreadStore.getState().isUnread('ch-b')).toBe(true); // not swallowed
  });

  it('a covered NOTIFICATION neither badges nor shows a browser notification', () => {
    // A delayed mention already covered by the watermark must be fully dropped:
    // no optimistic badge bump, no stale browser notification.
    useUnreadStore.setState({
      readStates: {
        'ch-c': { userId: '', channelId: 'ch-c', lastMessageId: 'm9', lastReadAt: '2026-07-14T12:00:10Z', lastReadSeq: 90, mentionCount: 0 },
      },
      unreadChannels: new Set(),
    });
    let incremented = false;
    const origInc = useUnreadStore.getState().incrementMention;
    useUnreadStore.setState({ incrementMention: () => { incremented = true; } });
    handlers['NOTIFICATION']({
      channelId: 'ch-c', mentionCount: 1, seq: 85, createdAt: '2026-07-14T12:00:20Z',
      senderName: 'x', channelName: 'y', content: 'z',
    });
    expect(useUnreadStore.getState().isUnread('ch-c')).toBe(false); // covered
    expect(incremented).toBe(false); // no optimistic badge
    useUnreadStore.setState({ incrementMention: origInc });
  });

  it('NOTIFICATION passes the server-minted createdAt through to markUnread', () => {
    // A delayed notification whose message predates the committed lastReadAt
    // must not permanently restore isUnread -- same contract as MESSAGE_CREATE.
    useUnreadStore.setState({
      readStates: {
        'ch-n': { userId: '', channelId: 'ch-n', lastMessageId: 'm9', lastReadAt: '2026-07-14T12:00:10Z', mentionCount: 0 },
      },
      unreadChannels: new Set(),
    });
    vi.mocked(client.apiGetReadStates).mockResolvedValue([] as never); // mention-triggered follow-up
    handlers['NOTIFICATION']({
      channelId: 'ch-n',
      mentionCount: 1,
      createdAt: '2026-07-14T12:00:05Z', // predates the ack that covered it
      senderName: '', channelName: '', content: '',
    });
    expect(useUnreadStore.getState().isUnread('ch-n')).toBe(false); // dropped by the clock guard
    handlers['NOTIFICATION']({
      channelId: 'ch-n',
      mentionCount: 1,
      createdAt: '2026-07-14T12:00:15Z', // genuinely newer
      senderName: '', channelName: '', content: '',
    });
    expect(useUnreadStore.getState().isUnread('ch-n')).toBe(true);
  });
});
