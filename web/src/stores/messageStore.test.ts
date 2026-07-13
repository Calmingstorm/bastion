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
});
