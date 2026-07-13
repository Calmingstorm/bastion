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

function msg(id: string, createdAt: string): Message {
  return { id, channelId: 'c1', author: { id: 'u1' }, content: id, createdAt } as Message;
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
});
