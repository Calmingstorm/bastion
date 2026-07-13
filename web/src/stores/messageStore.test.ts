import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from '../types';

vi.mock('../api/client', () => ({
  apiGetMessages: vi.fn(),
  apiSendMessage: vi.fn(),
  apiEditMessage: vi.fn(),
  apiDeleteMessage: vi.fn(),
}));

import { useMessageStore } from './messageStore';
import * as client from '../api/client';

function msg(id: string, createdAt: string, content = id): Message {
  return { id, channelId: 'c1', author: { id: 'u1' }, content, createdAt } as Message;
}

describe('messageStore.fetchMessages', () => {
  beforeEach(() => {
    useMessageStore.setState({ messages: {}, hasMore: {}, isLoading: {} });
    vi.mocked(client.apiGetMessages).mockReset();
  });

  it('replaces on an initial load', async () => {
    // The API returns DESC (newest first); the store reverses to ASC.
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m3', '2026-01-03'), msg('m2', '2026-01-02')]);
    await useMessageStore.getState().fetchMessages('c1');
    expect(useMessageStore.getState().messages.c1.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('merges on a reconnect resync, preserving scrolled-in history and deduping', async () => {
    // Existing: older scrolled-in history (m1, m2) plus a later live message (m5).
    useMessageStore.setState({
      messages: { c1: [msg('m1', '2026-01-01'), msg('m2', '2026-01-02'), msg('m5', '2026-01-05')] },
      hasMore: { c1: true },
    });
    // The resync returns the latest page: m5 (overlap) and a new m4.
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m5', '2026-01-05'), msg('m4', '2026-01-04')]);

    await useMessageStore.getState().fetchMessages('c1', undefined, true);

    // Union deduped by id and sorted ascending: history (m1, m2) survives (a
    // wholesale replace would drop it), m4 is added, and m5 is not duplicated.
    expect(useMessageStore.getState().messages.c1.map((m) => m.id)).toEqual(['m1', 'm2', 'm4', 'm5']);
    // Older-history availability is unchanged by a resync.
    expect(useMessageStore.getState().hasMore.c1).toBe(true);
  });

  it('does not overwrite live updates or resurrect live deletes during the resync', async () => {
    useMessageStore.setState({
      messages: { c1: [msg('m1', '2026-01-01', 'v1'), msg('m2', '2026-01-02')] },
      hasMore: { c1: false },
    });

    // While the fetch is in flight, live events land: m1 is edited and m2 is
    // deleted. The fetched page is the pre-change (stale) snapshot.
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.setState((s) => ({
        messages: {
          c1: (s.messages.c1 || [])
            .filter((m) => m.id !== 'm2')
            .map((m) => (m.id === 'm1' ? msg('m1', '2026-01-01', 'edited') : m)),
        },
      }));
      return [msg('m2', '2026-01-02'), msg('m1', '2026-01-01', 'v1')]; // DESC, stale
    });

    await useMessageStore.getState().fetchMessages('c1', undefined, true);

    const list = useMessageStore.getState().messages.c1;
    expect(list.map((m) => m.id)).toEqual(['m1']); // m2 stays deleted, not resurrected
    expect(list[0].content).toBe('edited'); // live edit preserved, not clobbered by stale fetch
  });

  it('applies a server edit missed while disconnected (unchanged local -> fetched wins)', async () => {
    // Local copy is stale and untouched since the request began.
    useMessageStore.setState({
      messages: { c1: [msg('m1', '2026-01-01', 'stale')] },
      hasMore: { c1: false },
    });
    // The server edited m1 while we were disconnected; the resync must apply it.
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m1', '2026-01-01', 'server-edited')]);

    await useMessageStore.getState().fetchMessages('c1', undefined, true);

    const list = useMessageStore.getState().messages.c1;
    expect(list.map((m) => m.id)).toEqual(['m1']);
    expect(list[0].content).toBe('server-edited');
  });

  it('does not resurrect when live deletes empty the list during the resync', async () => {
    useMessageStore.setState({
      messages: { c1: [msg('m1', '2026-01-01'), msg('m2', '2026-01-02')] },
      hasMore: { c1: false },
    });
    // Both messages are deleted during the fetch; the fetched page is stale.
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.setState({ messages: { c1: [] } });
      return [msg('m2', '2026-01-02'), msg('m1', '2026-01-01')];
    });

    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(useMessageStore.getState().messages.c1).toEqual([]);
  });

  it('does not resurrect a message deleted during the fetch that was absent at start', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false }, recentEvents: {} });
    // A realtime delete for m9 arrives during the fetch; m9 was never loaded here,
    // but the older fetched page still contains it.
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().deleteMessage('c1', 'm9');
      return [msg('m9', '2026-01-09')];
    });

    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(useMessageStore.getState().messages.c1).toEqual([]);
  });

  it('applies a realtime update during the fetch to a message absent at start', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false }, recentEvents: {} });
    // m9 is not loaded; a realtime update lands during the fetch, and the older
    // fetched page carries the pre-update (stale) copy.
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().updateMessage('c1', msg('m9', '2026-01-09', 'live-edit'));
      return [msg('m9', '2026-01-09', 'stale')];
    });

    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const list = useMessageStore.getState().messages.c1;
    expect(list.map((m) => m.id)).toEqual(['m9']);
    expect(list[0].content).toBe('live-edit'); // realtime update wins over the stale fetch
  });

  it('runs a merge resync even when a load is already in flight', async () => {
    useMessageStore.setState({
      messages: { c1: [msg('m1', '2026-01-01')] },
      hasMore: { c1: false },
      isLoading: { c1: true }, // a pagination is in flight
      recentEvents: {},
    });
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m2', '2026-01-02'), msg('m1', '2026-01-01')]);

    await useMessageStore.getState().fetchMessages('c1', undefined, true);

    // The resync was NOT skipped by isLoading: the missed message is now present.
    expect(useMessageStore.getState().messages.c1.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(client.apiGetMessages).toHaveBeenCalled();
  });

  it('reset clears recent-event tombstones', () => {
    useMessageStore.setState({ recentEvents: { m1: { gen: 1, ts: Date.now(), kind: 'delete' } } });
    useMessageStore.getState().reset();
    expect(useMessageStore.getState().recentEvents).toEqual({});
  });
});
