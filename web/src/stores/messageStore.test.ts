import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from '../types';

vi.mock('../api/client', () => ({
  apiGetMessages: vi.fn(),
  apiSendMessage: vi.fn(),
  apiSendMessageWithFiles: vi.fn(),
  apiEditMessage: vi.fn(),
  apiDeleteMessage: vi.fn(),
  linkAbortToSession: vi.fn(() => vi.fn()), // returns a fresh unlink spy per call
}));

vi.mock('./toastStore', () => {
  const addToast = vi.fn();
  return { useToastStore: { getState: () => ({ addToast, toasts: [], removeToast: vi.fn() }) } };
});

import { useMessageStore } from './messageStore';
import * as client from '../api/client';
import { useToastStore } from './toastStore';

function tISO(sec: number): string {
  return `2026-01-01T00:00:${String(sec).padStart(2, '0')}.000Z`;
}
function msg(id: string, createdAt: string, content = id): Message {
  return { id, channelId: 'c1', author: { id: 'u1' }, content, createdAt } as Message;
}
// ASC block of `count` messages, ids `${prefix}0..`, timestamps starting at startSec.
function block(prefix: string, count: number, startSec: number): Message[] {
  return Array.from({ length: count }, (_, i) => msg(`${prefix}${i}`, tISO(startSec + i)));
}
// API returns DESC (newest first).
function desc(list: Message[]): Message[] {
  return [...list].reverse();
}
function ids(): string[] {
  return (useMessageStore.getState().messages.c1 || []).map((m) => m.id);
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reactionUsers(id: string, emoji: string): string[] {
  const m = (useMessageStore.getState().messages.c1 || []).find((x) => x.id === id);
  return m?.reactions?.find((r) => r.emoji === emoji)?.users || [];
}

const LIMIT = 50;

describe('messageStore.fetchMessages', () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    vi.mocked(client.apiGetMessages).mockReset();
    vi.mocked(useToastStore.getState().addToast).mockClear();
  });

  // --- Basics --------------------------------------------------------------

  it('replaces on an initial load', async () => {
    vi.mocked(client.apiGetMessages).mockResolvedValue(desc([msg('m2', tISO(2)), msg('m3', tISO(3))]));
    await useMessageStore.getState().fetchMessages('c1');
    expect(ids()).toEqual(['m2', 'm3']);
  });

  it('applies a server edit missed while disconnected (no realtime event -> fetched wins)', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1), 'stale')] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m1', tISO(1), 'server-edited')]);
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(useMessageStore.getState().messages.c1[0].content).toBe('server-edited');
  });

  it('runs a merge resync even when a load is already in flight', async () => {
    useMessageStore.setState({
      messages: { c1: [msg('m1', tISO(1))] },
      hasMore: { c1: false },
      isLoading: { c1: true },
    });
    vi.mocked(client.apiGetMessages).mockResolvedValue(desc([msg('m1', tISO(1)), msg('m2', tISO(2))]));
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(ids()).toEqual(['m1', 'm2']);
    expect(client.apiGetMessages).toHaveBeenCalled();
  });

  // --- Matrix 1: initial A then resync B, both completion orders, B wins ----

  it('resync (later base) wins when it completes AFTER the initial load', async () => {
    const a = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => a.promise) // A: initial
      .mockResolvedValueOnce(desc([msg('m1', tISO(1), 'B'), msg('m2', tISO(2))])); // B: resync
    const aDone = useMessageStore.getState().fetchMessages('c1'); // seq 1
    await useMessageStore.getState().fetchMessages('c1', undefined, true); // seq 2 applies [m1 B, m2]
    a.resolve([msg('m1', tISO(1), 'A')]); // A settles later, stale
    await aDone;
    expect(ids()).toEqual(['m1', 'm2']);
    expect(useMessageStore.getState().messages.c1[0].content).toBe('B');
  });

  it('resync (later base) wins when it completes BEFORE the stale initial load', async () => {
    const a = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => a.promise) // A: initial (seq 1)
      .mockImplementationOnce(() => b.promise); // B: resync (seq 2)
    const aDone = useMessageStore.getState().fetchMessages('c1');
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true);
    b.resolve(desc([msg('m1', tISO(1), 'B'), msg('m2', tISO(2))])); // B settles first
    await bDone;
    a.resolve([msg('m1', tISO(1), 'A')]); // A settles later -> discarded (older base)
    await aDone;
    expect(ids()).toEqual(['m1', 'm2']);
    expect(useMessageStore.getState().messages.c1[0].content).toBe('B');
  });

  // --- Matrix 2: reactions during a held fetch, loaded and absent ----------

  it('applies a reaction that lands during a resync on a LOADED message', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addReaction('c1', 'm1', '👍', 'u2');
      return [msg('m1', tISO(1))]; // stale copy, no reaction
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(reactionUsers('m1', '👍')).toEqual(['u2']);
  });

  it('applies a reaction for a message ABSENT at start once the fetch supplies the baseline', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addReaction('c1', 'm9', '🎉', 'u2'); // m9 not loaded -> patch
      return [msg('m9', tISO(9))]; // fetch supplies the baseline
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(reactionUsers('m9', '🎉')).toEqual(['u2']);
  });

  it('applies a reaction REMOVAL patch for an absent message onto the fetched baseline', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    const withReaction = { ...msg('m9', tISO(9)), reactions: [{ emoji: '👍', count: 1, users: ['u2'] }] } as Message;
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().removeReaction('c1', 'm9', '👍', 'u2'); // patch remove
      return [withReaction];
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(reactionUsers('m9', '👍')).toEqual([]);
  });

  it('reaction add is idempotent (optimistic + realtime echo does not double-count)', () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] } });
    useMessageStore.getState().addReaction('c1', 'm1', '👍', 'u2');
    useMessageStore.getState().addReaction('c1', 'm1', '👍', 'u2');
    expect(reactionUsers('m1', '👍')).toEqual(['u2']);
    expect(useMessageStore.getState().messages.c1[0].reactions?.[0].count).toBe(1);
  });

  // --- Matrix 3: empty / partial / full-overlap / full-no-overlap ----------

  it('resync with an EMPTY response drops all cached messages and clears hasMore', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, hasMore: { c1: true } });
    vi.mocked(client.apiGetMessages).mockResolvedValue([]);
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(ids()).toEqual([]);
    expect(useMessageStore.getState().hasMore.c1).toBe(false);
  });

  it('resync with a PARTIAL page applies a delete missed while disconnected', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1)), msg('m2', tISO(2))] }, hasMore: { c1: true } });
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m2', tISO(2))]); // m1 deleted while offline
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(ids()).toEqual(['m2']);
    expect(useMessageStore.getState().hasMore.c1).toBe(false);
  });

  it('resync with a FULL page that overlaps the cache keeps history below the window', async () => {
    const latest = block('m', LIMIT, 10); // m0..m49 @ sec 10..59
    useMessageStore.setState({
      messages: { c1: [msg('h0', tISO(0)), ...latest] }, // h0 is older scrolled-in history
      hasMore: { c1: true },
    });
    vi.mocked(client.apiGetMessages).mockResolvedValue(desc(latest)); // same latest 50 (overlap)
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const got = ids();
    expect(got).toContain('h0'); // history preserved
    expect(got.length).toBe(LIMIT + 1);
    expect(useMessageStore.getState().hasMore.c1).toBe(true); // provenance preserved
  });

  it('resync with a FULL page and NO overlap drops the stale cache and sets hasMore', async () => {
    useMessageStore.setState({ messages: { c1: block('old', LIMIT, 0) }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockResolvedValue(desc(block('n', LIMIT, 100))); // 50 all-new
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const got = ids();
    expect(got).not.toContain('old0'); // gap -> old segment dropped
    expect(got).toContain('n0');
    expect(got.length).toBe(LIMIT);
    expect(useMessageStore.getState().hasMore.c1).toBe(true); // scroll can rebuild history
  });

  // --- Matrix 4: a post-start create must not manufacture false overlap ----

  it('a realtime create during the fetch does not count as cache overlap', async () => {
    useMessageStore.setState({ messages: { c1: [msg('old0', tISO(0))] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      // n0 is in the fetched page; adding it now would look like overlap if overlap
      // were read from settlement state instead of request-start ids.
      useMessageStore.getState().addMessage('c1', block('n', LIMIT, 100)[0]);
      return desc(block('n', LIMIT, 100));
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const got = ids();
    expect(got).not.toContain('old0'); // no true overlap -> old segment dropped
    expect(got.length).toBe(LIMIT);
  });

  // --- Matrix 5: pagination invalidated by a no-overlap base reset ----------

  it('a pagination started before a gap reset does not reattach its stale segment', async () => {
    useMessageStore.setState({ messages: { c1: block('old', LIMIT, 50) }, hasMore: { c1: true } });
    const p = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => p.promise) // pagination (older page), held
      .mockResolvedValueOnce(desc(block('n', LIMIT, 200))); // resync: full, no overlap -> gap

    const pDone = useMessageStore.getState().fetchMessages('c1', 'old0'); // pagination starts (epoch 0)
    await useMessageStore.getState().fetchMessages('c1', undefined, true); // gap reset -> epoch advances
    p.resolve(desc(block('p', LIMIT, 0))); // pagination settles against the OLD window
    await pDone;

    const got = ids();
    expect(got).not.toContain('p0'); // stale older segment not spliced back
    expect(got).toContain('n0');
    expect(got.length).toBe(LIMIT);
  });

  // --- Matrix 6: empty response preserves only legitimate post-start upserts

  it('an empty response preserves a post-start create but drops pre-start cache', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, hasMore: { c1: true } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addMessage('c1', msg('m2', tISO(2))); // post-start create
      return []; // empty latest window
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(ids()).toEqual(['m2']); // m1 (pre-start) dropped, m2 (post-start) kept
  });

  // --- Matrix 7: reset during an in-flight request blocks its commit -------

  it('a reset during an in-flight resync prevents the response from committing', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages).mockImplementation(() => b.promise);
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true);
    useMessageStore.getState().reset(); // session epoch bumps
    b.resolve(desc([msg('m1', tISO(1)), msg('m2', tISO(2))]));
    await bDone;
    expect(useMessageStore.getState().messages.c1 || []).toEqual([]);
  });

  // --- Reconcile fundamentals via real mutations ---------------------------

  it('does not resurrect a message deleted by realtime during the fetch', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1)), msg('m2', tISO(2))] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().deleteMessage('c1', 'm2');
      return desc([msg('m1', tISO(1)), msg('m2', tISO(2))]); // stale page still has m2
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(ids()).toEqual(['m1']);
  });

  it('pagination does not resurrect a realtime-deleted message', async () => {
    useMessageStore.setState({
      messages: { c1: [msg('m5', tISO(50)), msg('m6', tISO(51))] },
      hasMore: { c1: true },
    });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().deleteMessage('c1', 'm4');
      return desc([msg('m3', tISO(30)), msg('m4', tISO(40))]); // older page containing m4
    });
    await useMessageStore.getState().fetchMessages('c1', 'm5');
    expect(ids()).toEqual(['m3', 'm5', 'm6']);
  });

  it('does not prune a journal entry a slow resync still needs', async () => {
    vi.useFakeTimers();
    try {
      useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
      const b = deferred<Message[]>();
      vi.mocked(client.apiGetMessages).mockImplementation(() => b.promise);
      const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // resync active
      useMessageStore.getState().updateMessage('c1', msg('m9', tISO(9), 'live')); // journal upsert, ver > start
      vi.advanceTimersByTime(61_000); // age past the 60s window
      useMessageStore.getState().deleteMessage('c1', 'unrelated'); // triggers pruning
      b.resolve([msg('m9', tISO(9), 'stale')]);
      await bDone;
      const list = useMessageStore.getState().messages.c1;
      expect(list.map((m) => m.id)).toEqual(['m9']);
      expect(list[0].content).toBe('live'); // survived pruning -> applied over the stale page
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset clears the reconciliation journal', () => {
    useMessageStore.getState().deleteMessage('c1', 'm1'); // records a journal entry
    expect(Object.keys(useMessageStore.getState().journal).length).toBeGreaterThan(0);
    useMessageStore.getState().reset();
    expect(useMessageStore.getState().journal).toEqual({});
  });

  // --- Journal composition: content and reactions are independent ----------

  it('a reaction on a loaded message does not let its stale content beat a fetched edit', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1), 'old')] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addReaction('c1', 'm1', '👍', 'u2'); // reaction during the fetch
      return [msg('m1', tISO(1), 'server-edit')]; // the server also edited the content
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const m = useMessageStore.getState().messages.c1[0];
    expect(m.content).toBe('server-edit'); // content edit wins on its dimension
    expect(reactionUsers('m1', '👍')).toEqual(['u2']); // reaction preserved on its dimension
  });

  it('a reaction then a content update on an absent message keeps both', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addReaction('c1', 'm9', '🎉', 'u2'); // patch (m9 absent)
      useMessageStore.getState().updateMessage('c1', msg('m9', tISO(9), 'updated')); // content op after
      return [msg('m9', tISO(9), 'orig')]; // stale baseline
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const m = useMessageStore.getState().messages.c1[0];
    expect(m.content).toBe('updated'); // realtime content update wins
    expect(reactionUsers('m9', '🎉')).toEqual(['u2']); // reaction survived the later content update
  });

  // --- Base ordering by newest-STARTED, not newest-applied -----------------

  it('an initial load that resolves first does not commit when a later resync has started', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    const a = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => a.promise) // A: initial (seq 1)
      .mockImplementationOnce(() => b.promise); // B: resync (seq 2, started later)
    const aDone = useMessageStore.getState().fetchMessages('c1');
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true);
    a.resolve([msg('m1', tISO(1), 'A')]); // A resolves FIRST
    await aDone;
    expect(ids()).toEqual([]); // A did NOT commit -- a newer base fetch had already started
    b.resolve(desc([msg('m1', tISO(1), 'B'), msg('m2', tISO(2))]));
    await bDone;
    expect(ids()).toEqual(['m1', 'm2']);
    expect(useMessageStore.getState().messages.c1[0].content).toBe('B');
  });

  // --- Reset isolates a request begun before it ----------------------------

  it('an error from a request begun before reset does not touch the new session', async () => {
    useMessageStore.setState({ messages: { c1: [] } });
    const a = deferred<Message[]>();
    vi.mocked(client.apiGetMessages).mockImplementation(() => a.promise);
    const aDone = useMessageStore.getState().fetchMessages('c1'); // sets isLoading, error=null
    useMessageStore.getState().reset(); // new session
    a.reject(new Error('network')); // the old request fails after the reset
    await aDone;
    expect(useMessageStore.getState().error.c1).toBeFalsy(); // no stale error written
    expect(useMessageStore.getState().isLoading.c1).toBeFalsy();
  });

  // --- A partial content edit must not erase other dimensions --------------

  function withReaction(id: string, createdAt: string, content: string, emoji: string, user: string): Message {
    return { ...msg(id, createdAt, content), reactions: [{ emoji, count: 1, users: [user] }] } as Message;
  }

  it('a live content update preserves the loaded reactions', () => {
    useMessageStore.setState({ messages: { c1: [withReaction('m1', tISO(1), 'old', '👍', 'u2')] } });
    useMessageStore.getState().updateMessage('c1', msg('m1', tISO(1), 'edited')); // partial MESSAGE_UPDATE
    const m = useMessageStore.getState().messages.c1[0];
    expect(m.content).toBe('edited');
    expect(reactionUsers('m1', '👍')).toEqual(['u2']); // reaction not erased by the partial edit
  });

  it('a content update during a resync preserves reactions from the fetched baseline', async () => {
    const baseline = withReaction('m1', tISO(1), 'old', '👍', 'u2');
    useMessageStore.setState({ messages: { c1: [baseline] }, hasMore: { c1: false } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().updateMessage('c1', msg('m1', tISO(1), 'edited')); // partial edit during fetch
      return [baseline]; // fetched baseline still carries the reaction
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const m = useMessageStore.getState().messages.c1[0];
    expect(m.content).toBe('edited'); // realtime edit applied
    expect(reactionUsers('m1', '👍')).toEqual(['u2']); // reaction preserved from the baseline
  });

  // --- Obsolete pagination failure must not clobber fresh state ------------

  it('an obsolete pagination failure does not surface a stale error', async () => {
    useMessageStore.setState({ messages: { c1: block('old', LIMIT, 50) }, hasMore: { c1: true } });
    const p = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => p.promise) // pagination (older page), held
      .mockResolvedValueOnce(desc(block('n', LIMIT, 200))); // resync: full, no overlap -> gap

    const pDone = useMessageStore.getState().fetchMessages('c1', 'old0'); // pagination starts (epoch 0)
    await useMessageStore.getState().fetchMessages('c1', undefined, true); // gap reset -> epoch advances
    p.reject(new Error('network')); // the now-obsolete pagination fails
    await pDone;

    expect(useMessageStore.getState().error.c1).toBeFalsy(); // no stale error over the fresh state
    expect(ids()).toContain('n0');
  });

  // --- Reaction patches per message are bounded ---------------------------

  it('per-message reaction patches stay bounded under churn', () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] } });
    for (let i = 0; i < 200; i++) useMessageStore.getState().addReaction('c1', 'm1', '👍', `u${i}`);
    const patches = useMessageStore.getState().journal['m1']?.reactions.length ?? 0;
    expect(patches).toBeLessThanOrEqual(1); // compacted -- not one-per-reaction
  });

  it('keeps every reaction applied while a fetch is held (no truncation)', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, hasMore: { c1: false } });
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages).mockImplementation(() => b.promise);
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // held -> pins protectFloor
    for (let i = 0; i < 600; i++) useMessageStore.getState().addReaction('c1', 'm1', '👍', `u${i}`);
    b.resolve([msg('m1', tISO(1))]); // stale baseline, no reactions
    await bDone;
    // All 600 patches are an active fetch's required evidence -- none truncated.
    expect(useMessageStore.getState().messages.c1[0].reactions?.find((r) => r.emoji === '👍')?.count).toBe(600);
  });

  // --- Full creates reconcile whole, not as partial edits ------------------

  const attach = () => [
    { id: 'a1', messageId: 'm9', filename: 'f.png', storedName: 's', contentType: 'image/png', size: 1, url: '/u', createdAt: tISO(9) },
  ];

  it('a realtime create during a resync recovers its attachments (the List omits them)', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    const create = { ...msg('m9', tISO(9), 'hi'), attachments: attach() } as Message;
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addMessage('c1', create); // realtime create carries attachments
      // The List returns the message WITHOUT attachments but WITH a fresh reply preview.
      return [{ ...msg('m9', tISO(9), 'hi'), replyTo: { id: 'r1', content: 'parent', author: { id: 'u3' } } } as Message];
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const m = useMessageStore.getState().messages.c1.find((x) => x.id === 'm9')!;
    expect(m.attachments?.length).toBe(1); // recovered from the create
    expect(m.replyTo?.id).toBe('r1'); // from the fetched copy (server), not lost
  });

  it('a create then a partial edit keeps attachments but takes fresh author/reply from the fetch', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false } });
    const staleCreate = {
      ...msg('m9', tISO(9), 'hi'),
      attachments: attach(),
      author: { id: 'u1', username: 'old-name' },
      replyTo: { id: 'r1', content: 'STALE parent', author: { id: 'u3' } },
    } as Message;
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      useMessageStore.getState().addMessage('c1', staleCreate); // create (pre-fetch metadata)
      useMessageStore.getState().updateMessage('c1', msg('m9', tISO(9), 'edited')); // partial edit
      // Fetched has FRESH author/reply from the server (and, as always, no attachments).
      return [
        {
          ...msg('m9', tISO(9), 'hi'),
          author: { id: 'u1', username: 'new-name' },
          replyTo: { id: 'r1', content: 'FRESH parent', author: { id: 'u3' } },
        } as Message,
      ];
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    const m = useMessageStore.getState().messages.c1.find((x) => x.id === 'm9')!;
    expect(m.content).toBe('edited'); // newest content op wins
    expect(m.attachments?.length).toBe(1); // create's attachments recovered (List omits them)
    expect(m.replyTo?.content).toBe('FRESH parent'); // fresh reply preview from fetch, not the stale create
    expect(m.author.username).toBe('new-name'); // fresh author from fetch, not the stale create
  });

  it('a fetch abandoned by the protection timeout cannot erase later realtime state', async () => {
    vi.useFakeTimers();
    try {
      useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, hasMore: { c1: false } });
      const b = deferred<Message[]>();
      vi.mocked(client.apiGetMessages).mockImplementation(() => b.promise);
      const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // held resync
      vi.advanceTimersByTime(120_001); // protection timeout fires -> fetch abandoned + deregistered
      useMessageStore.getState().addReaction('c1', 'm1', '👍', 'u2'); // reaction arrives AFTER abandonment
      b.resolve([msg('m1', tISO(1))]); // the stale response finally arrives (no reaction)
      await bDone;
      // The abandoned response did not commit, so it did not erase the realtime reaction.
      expect(reactionUsers('m1', '👍')).toEqual(['u2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abandoned initial load surfaces an error rather than retrying or staying empty', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.mocked(client.apiGetMessages).mockImplementation(() => {
        calls += 1;
        return new Promise(() => {}); // hangs
      });
      useMessageStore.setState({ messages: {}, isLoading: {}, error: {}, errorSeq: {}, committedSeq: {} });
      void useMessageStore.getState().fetchMessages('c1'); // initial load, hangs
      expect(calls).toBe(1);
      vi.advanceTimersByTime(120_001); // abandon
      expect(calls).toBe(1); // NOT retried -- a spurious newer base fetch would discard a healthy resync
      expect(useMessageStore.getState().isLoading.c1).toBe(false); // loading released
      // The channel shows an error (a retry affordance) instead of a false "empty".
      expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reconnect resync clears the error left by an abandoned initial load', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.apiGetMessages).mockImplementationOnce(() => new Promise(() => {})); // initial load hangs
      useMessageStore.setState({ messages: {}, isLoading: {}, error: {}, errorSeq: {}, committedSeq: {} });
      void useMessageStore.getState().fetchMessages('c1');
      vi.advanceTimersByTime(120_001); // abandon -> error surfaced
      expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
      vi.useRealTimers();
      // A later reconnect resync succeeds and clears the stale error.
      vi.mocked(client.apiGetMessages).mockResolvedValueOnce([msg('m1', tISO(1))]);
      await useMessageStore.getState().fetchMessages('c1', undefined, true);
      expect(useMessageStore.getState().error.c1).toBeFalsy();
      expect(ids()).toEqual(['m1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an older pagination success does not clear a newer resync failure', async () => {
    useMessageStore.setState({ messages: { c1: block('old', LIMIT, 50) }, hasMore: { c1: true } });
    const p = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => p.promise) // pagination A (seq 1)
      .mockImplementationOnce(() => b.promise); // resync B (seq 2)
    const pDone = useMessageStore.getState().fetchMessages('c1', 'old0'); // A
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // B (newer)
    b.reject(new Error('boom')); // B fails first -> writes error stamped seq 2
    await bDone;
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
    p.resolve(desc(block('p', LIMIT, 0))); // A (older) succeeds afterward
    await pDone;
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.'); // A did not clear B's newer error
  });

  it('an older pagination failure does not publish an error over a newer resync success', async () => {
    useMessageStore.setState({ messages: { c1: block('old', LIMIT, 50) }, hasMore: { c1: true }, error: {} });
    const p = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => p.promise) // pagination A (seq 1)
      .mockImplementationOnce(() => b.promise); // resync B (seq 2)
    const pDone = useMessageStore.getState().fetchMessages('c1', 'old0'); // A
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // B (newer)
    b.resolve(desc(block('old', LIMIT, 50))); // full-overlap resync -> commits, epoch NOT advanced
    await bDone;
    expect(useMessageStore.getState().error.c1).toBeFalsy();
    p.reject(new Error('boom')); // A (older) fails afterward
    await pDone;
    expect(useMessageStore.getState().error.c1).toBeFalsy(); // A's failure did not overwrite B's newer success
  });

  it('a newer pagination success does not suppress a resync failure', async () => {
    useMessageStore.setState({ messages: { c1: block('old', LIMIT, 50) }, hasMore: { c1: true }, error: {} });
    const b = deferred<Message[]>();
    const p = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => b.promise) // resync B (base, seq 1, started first)
      .mockImplementationOnce(() => p.promise); // pagination A (seq 2)
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // resync (seq 1)
    const pDone = useMessageStore.getState().fetchMessages('c1', 'old0'); // pagination (seq 2, newer)
    p.resolve(desc(block('p', LIMIT, 0))); // pagination succeeds first
    await pDone;
    b.reject(new Error('boom')); // resync fails afterward
    await bDone;
    // Pagination loads older history; it cannot refresh the latest window, so its
    // success must not suppress the resync's genuine latest-window failure.
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
  });

  it('starting a pagination does not clear an existing latest-window error', async () => {
    useMessageStore.setState({
      messages: { c1: block('m', LIMIT, 100) },
      hasMore: { c1: true },
      error: { c1: 'Failed to load messages.' },
      errorSeq: { c1: 5 },
    });
    vi.mocked(client.apiGetMessages).mockResolvedValue(desc(block('old', LIMIT, 0))); // older page
    await useMessageStore.getState().fetchMessages('c1', 'm0'); // pagination
    // Pagination is non-merge but does not establish the latest window, so its start
    // must not optimistically clear the window's error.
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
  });

  it('an older pagination failure does not overwrite a newer base failure', async () => {
    useMessageStore.setState({ messages: { c1: block('m', LIMIT, 100) }, hasMore: { c1: true }, error: {} });
    const p = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => p.promise) // pagination A (seq 1, starts first)
      .mockImplementationOnce(() => b.promise); // resync B (seq 2)
    const pDone = useMessageStore.getState().fetchMessages('c1', 'm0'); // A (seq 1)
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // B (seq 2, newer)
    b.reject(new Error('boom')); // B (newer) fails first -> error stamped with B's seq
    await bDone;
    const bErrorSeq = useMessageStore.getState().errorSeq.c1; // B's (newer) sequence
    expect(bErrorSeq).toBeGreaterThan(0);
    p.reject(new Error('boom')); // A (older) fails afterward
    await pDone;
    // A's older failure must not overwrite B's newer error (seq unchanged).
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
    expect(useMessageStore.getState().errorSeq.c1).toBe(bErrorSeq);
  });

  it('a reaction on an absent message does not resurrect it against an empty response', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, hasMore: { c1: true } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      // m1 was deleted server-side; a stray reaction races in during the fetch.
      useMessageStore.getState().addReaction('c1', 'm1', '👍', 'u2');
      return []; // authoritative empty response
    });
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(ids()).toEqual([]); // a reaction cannot supply a content baseline, so m1 stays gone
  });

  it('a pagination abandoned by the timeout aborts and releases loading without retrying', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      let calls = 0;
      vi.mocked(client.apiGetMessages).mockImplementation((_c, _b, _l, signal) => {
        calls += 1;
        return new Promise((_res, rej) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            rej(new DOMException('aborted', 'AbortError'));
          });
        });
      });
      useMessageStore.setState({ messages: { c1: block('m', LIMIT, 0) }, hasMore: { c1: true }, isLoading: {} });
      const done = useMessageStore.getState().fetchMessages('c1', 'm0'); // pagination
      vi.advanceTimersByTime(120_001); // protection timeout -> abandon
      expect(aborted).toBe(true); // the HTTP request was cancelled
      expect(useMessageStore.getState().isLoading.c1).toBe(false); // loading released (its .then clears loadingOlderRef)
      expect(calls).toBe(1); // a pagination is NOT auto-retried (the user re-scrolls)
      await done; // and the promise settles (does not hang)
    } finally {
      vi.useRealTimers();
    }
  });

  it('a resync does not destroy attachments the client already holds', async () => {
    // Attachments arrive only via realtime create; here they live in the loaded copy.
    const loaded = { ...msg('m1', tISO(1)), attachments: attach() } as Message;
    useMessageStore.setState({ messages: { c1: [loaded] }, hasMore: { c1: false } });
    // A later resync returns m1 without attachments (the List omits them).
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m1', tISO(1))]);
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(useMessageStore.getState().messages.c1[0].attachments?.length).toBe(1); // recovered, not dropped
  });

  it('a later success in another channel does not suppress an earlier failure', async () => {
    const a = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => a.promise) // c1 (seq 1), will fail
      .mockResolvedValueOnce([msg('x1', tISO(1))]); // c2 (seq 2), succeeds
    const aDone = useMessageStore.getState().fetchMessages('c1'); // c1 starts (seq 1)
    await useMessageStore.getState().fetchMessages('c2'); // c2 succeeds (seq 2) -> committedSeq.c2
    a.reject(new Error('boom')); // c1 fails afterward
    await aDone;
    // Per-channel gating: c2's newer success does not silence c1's genuine failure.
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
    expect(useMessageStore.getState().error.c2 ?? null).toBeFalsy();
  });

  // --- A successful commit clears a stale error ----------------------------

  it('a successful resync clears a stale error from a failed base load', async () => {
    useMessageStore.setState({ messages: { c1: [] }, hasMore: { c1: false }, error: {}, errorSeq: {}, committedSeq: {} });
    vi.mocked(client.apiGetMessages).mockRejectedValueOnce(new Error('network')); // initial (base) load fails
    await useMessageStore.getState().fetchMessages('c1');
    expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
    vi.mocked(client.apiGetMessages).mockResolvedValueOnce([msg('m1', tISO(1))]); // resync succeeds
    await useMessageStore.getState().fetchMessages('c1', undefined, true);
    expect(useMessageStore.getState().error.c1).toBeFalsy(); // the successful base commit cleared it
  });

  it('unlinks the session listener when a fetch settles', async () => {
    vi.mocked(client.apiGetMessages).mockResolvedValue([msg('m1', tISO(1))]);
    await useMessageStore.getState().fetchMessages('c1');
    // fetchMessages must unlink the session listener in its finally so nothing
    // lingers on the session signal after the request completes.
    const results = vi.mocked(client.linkAbortToSession).mock.results;
    const unlink = results[results.length - 1]?.value as ReturnType<typeof vi.fn>;
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('a pagination failure does not set the latest-window error', async () => {
    useMessageStore.setState({ messages: { c1: block('m', LIMIT, 100) }, hasMore: { c1: true }, error: {} });
    vi.mocked(client.apiGetMessages).mockRejectedValueOnce(new Error('network'));
    await useMessageStore.getState().fetchMessages('c1', 'm0'); // pagination fails
    // Pagination loads older history; its failure is not a latest-window error.
    expect(useMessageStore.getState().error.c1 ?? null).toBeFalsy();
  });

  it('an abandoned initial load does not surface a retry that would discard a healthy resync', async () => {
    vi.useFakeTimers();
    try {
      useMessageStore.setState({
        messages: { c1: [] },
        isLoading: {},
        error: {},
        errorSeq: {},
        committedSeq: {},
        maxStartedBaseSeq: {},
      });
      const a = deferred<Message[]>();
      const b = deferred<Message[]>();
      vi.mocked(client.apiGetMessages)
        .mockImplementationOnce(() => a.promise) // initial A (hangs)
        .mockImplementationOnce(() => b.promise); // resync B (newer, healthy)
      void useMessageStore.getState().fetchMessages('c1'); // A, protection timer @120000
      vi.advanceTimersByTime(1000);
      const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // B, timer @121000
      vi.advanceTimersByTime(119_001); // A abandons at t=120001; B still in flight
      // A must NOT surface a Retry -- clicking it would start a newer base fetch and
      // discard B's healthy response.
      expect(useMessageStore.getState().error.c1 ?? null).toBeFalsy();
      b.resolve([msg('m1', tISO(1))]); // B resolves with fresh data
      await bDone;
      expect(ids()).toEqual(['m1']); // B was not discarded
    } finally {
      vi.useRealTimers();
    }
  });

  it('a send failure does not set the latest-window error but does show a toast', async () => {
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1))] }, error: {} });
    vi.mocked(client.apiSendMessage).mockRejectedValue(new Error('boom'));
    await expect(useMessageStore.getState().sendMessage('c1', 'hi')).rejects.toThrow();
    // A send failure surfaces via a toast + the throw, NOT the base-load error field.
    expect(useMessageStore.getState().error.c1 ?? null).toBeFalsy();
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith('Failed to send message.');
  });

  it('an attachment (file) send failure shows a toast', async () => {
    vi.mocked(client.apiSendMessageWithFiles).mockRejectedValue(new Error('boom'));
    await expect(
      useMessageStore.getState().sendMessageWithFiles('c1', 'hi', [new File([], 'f.png')])
    ).rejects.toThrow();
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith('Failed to send message.');
  });

  it('a send cancelled on logout does not toast', async () => {
    vi.mocked(client.apiSendMessage).mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(useMessageStore.getState().sendMessage('c1', 'hi')).rejects.toThrow();
    // A cancellation is not a user-facing failure -- no toast into the next session.
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();
  });

  it('a resync clears an existing latest-window error when it starts (inverse retry race)', async () => {
    vi.useFakeTimers();
    try {
      // An abandoned initial load has surfaced the base error (Retry showing).
      useMessageStore.setState({
        messages: { c1: [] },
        isLoading: {},
        error: { c1: 'Failed to load messages.' },
        errorSeq: { c1: 5 },
        committedSeq: {},
        maxStartedBaseSeq: { c1: 5 },
      });
      const b = deferred<Message[]>();
      vi.mocked(client.apiGetMessages).mockImplementation(() => b.promise);
      const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // reconnect resync starts
      // Starting the resync hides the stale Retry immediately, so it can't be clicked
      // to spawn a superseding fetch.
      expect(useMessageStore.getState().error.c1 ?? null).toBeFalsy();
      vi.useRealTimers();
      b.resolve([msg('m1', tISO(1))]);
      await bDone;
      expect(ids()).toEqual(['m1']);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Single-flight base-fetch admission (blocker 1) ----------------------

  it('an initial load never commits once a resync preempts it (even if it resolves first)', async () => {
    const a = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => a.promise) // initial A
      .mockImplementationOnce(() => b.promise); // resync B preempts A
    const aDone = useMessageStore.getState().fetchMessages('c1');
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true);
    a.resolve([msg('m1', tISO(1), 'A')]); // A resolves FIRST
    await aDone;
    expect(ids()).toEqual([]); // A was preempted -> never commits
    b.resolve([msg('m2', tISO(2), 'B')]);
    await bDone;
    expect(ids()).toEqual(['m2']); // B is authoritative
  });

  it('a captured Retry invoked after a resync starts creates no request; B commits', async () => {
    vi.useFakeTimers();
    try {
      const a = deferred<Message[]>();
      const b = deferred<Message[]>();
      vi.mocked(client.apiGetMessages)
        .mockImplementationOnce(() => a.promise) // initial A (hangs)
        .mockImplementationOnce(() => b.promise); // resync B
      void useMessageStore.getState().fetchMessages('c1'); // A initial
      vi.advanceTimersByTime(120_001); // A abandons -> surfaces error, releases the base slot
      const staleGen = useMessageStore.getState().errorSeq.c1; // the Retry's captured generation
      expect(useMessageStore.getState().error.c1).toBe('Failed to load messages.');
      const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // reconnect resync
      const callsBefore = vi.mocked(client.apiGetMessages).mock.calls.length;
      useMessageStore.getState().retryLoad('c1', staleGen); // the already-captured Retry, invoked now
      expect(vi.mocked(client.apiGetMessages).mock.calls.length).toBe(callsBefore); // NO new request
      b.resolve([msg('m1', tISO(1))]);
      await bDone;
      expect(ids()).toEqual(['m1']); // B committed, not discarded
    } finally {
      vi.useRealTimers();
    }
  });

  it('a delayed initial-load effect invoked while a resync is active creates no request', async () => {
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages).mockImplementationOnce(() => b.promise);
    const bDone = useMessageStore.getState().fetchMessages('c1', undefined, true); // resync active
    const callsBefore = vi.mocked(client.apiGetMessages).mock.calls.length;
    void useMessageStore.getState().fetchMessages('c1'); // a late initial-load effect
    expect(vi.mocked(client.apiGetMessages).mock.calls.length).toBe(callsBefore); // no-op
    b.resolve([msg('m1', tISO(1))]);
    await bDone;
    expect(ids()).toEqual(['m1']);
  });

  it('after a resync abandons, the current Retry starts exactly one new fetch', async () => {
    vi.useFakeTimers();
    try {
      useMessageStore.setState({ messages: { c1: [] } });
      vi.mocked(client.apiGetMessages).mockImplementation(() => new Promise(() => {})); // hangs
      void useMessageStore.getState().fetchMessages('c1', undefined, true); // resync (base) hangs
      vi.advanceTimersByTime(120_001); // resync abandons -> surfaces error, releases the slot
      const gen = useMessageStore.getState().errorSeq.c1;
      const callsBefore = vi.mocked(client.apiGetMessages).mock.calls.length;
      useMessageStore.getState().retryLoad('c1', gen); // no base active, error current -> admitted
      expect(vi.mocked(client.apiGetMessages).mock.calls.length).toBe(callsBefore + 1); // exactly one
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale Retry whose error a completed resync already cleared creates no request', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.apiGetMessages).mockImplementationOnce(() => new Promise(() => {})); // A hangs
      void useMessageStore.getState().fetchMessages('c1'); // initial A
      vi.advanceTimersByTime(120_001); // A abandons -> surfaces error (this is the Retry's generation)
      const staleGen = useMessageStore.getState().errorSeq.c1;
      // A resync now runs to completion: it clears the error and releases the base slot.
      vi.mocked(client.apiGetMessages).mockResolvedValueOnce([msg('m1', tISO(1))]);
      await useMessageStore.getState().fetchMessages('c1', undefined, true);
      expect(useMessageStore.getState().error.c1 ?? null).toBeFalsy();
      expect(useMessageStore.getState().activeBase.c1).toBeUndefined();
      // No base is active now, so only the generation check stands between the stale
      // Retry and a spurious duplicate fetch of an already-healthy window.
      const callsBefore = vi.mocked(client.apiGetMessages).mock.calls.length;
      useMessageStore.getState().retryLoad('c1', staleGen);
      expect(vi.mocked(client.apiGetMessages).mock.calls.length).toBe(callsBefore); // stale gen -> no-op
    } finally {
      vi.useRealTimers();
    }
  });

  it('a preempted request settling cannot replace the resync as the active base', async () => {
    const a = deferred<Message[]>();
    const b = deferred<Message[]>();
    vi.mocked(client.apiGetMessages)
      .mockImplementationOnce(() => a.promise) // initial A
      .mockImplementationOnce(() => b.promise); // resync B preempts A
    const aDone = useMessageStore.getState().fetchMessages('c1');
    void useMessageStore.getState().fetchMessages('c1', undefined, true); // B takes the active slot
    const bId = useMessageStore.getState().activeBase.c1?.id;
    expect(bId).toBeDefined();
    a.resolve([msg('m1', tISO(1))]); // the preempted A now settles
    await aDone;
    // A's cleanup must NOT touch B's active-base slot.
    expect(useMessageStore.getState().activeBase.c1?.id).toBe(bId);
  });

  // --- Session-boundary guards on message mutations (round 24 blocker 1) ----
  // A mutation whose request settles around a logout/reset must not write its
  // result (or a toast) into the fresh session. reset() bumps sessionEpoch.

  it('a send that resolves after logout does not insert its message into the new session', async () => {
    const d = deferred<Message>();
    vi.mocked(client.apiSendMessage).mockReturnValue(d.promise);
    const p = useMessageStore.getState().sendMessage('c1', 'hi');
    useMessageStore.getState().reset(); // logout: new session
    d.resolve(msg('m1', tISO(1)));
    await p;
    expect(ids()).toEqual([]); // the old send did not repopulate the cleared store
  });

  it('a send that rejects after logout does not toast into the new session', async () => {
    const d = deferred<Message>();
    vi.mocked(client.apiSendMessage).mockReturnValue(d.promise);
    const p = useMessageStore.getState().sendMessage('c1', 'hi');
    useMessageStore.getState().reset();
    d.reject(new Error('500'));
    await expect(p).rejects.toThrow();
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled(); // no toast into the next user's UI
  });

  it('an upload that resolves after logout does not insert its message into the new session', async () => {
    const d = deferred<Message>();
    vi.mocked(client.apiSendMessageWithFiles).mockReturnValue(d.promise);
    const p = useMessageStore.getState().sendMessageWithFiles('c1', 'hi', [new File([], 'f.png')]);
    useMessageStore.getState().reset();
    d.resolve(msg('m1', tISO(1)));
    await p;
    expect(ids()).toEqual([]);
  });

  it('an edit that rejects after logout does not toast into the new session', async () => {
    const d = deferred<Message>();
    vi.mocked(client.apiEditMessage).mockReturnValue(d.promise);
    const p = useMessageStore.getState().editMessage('c1', 'm1', 'edited');
    useMessageStore.getState().reset();
    d.reject(new Error('500'));
    await expect(p).rejects.toThrow();
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();
  });

  it('a delete that rejects after logout does not toast into the new session', async () => {
    const d = deferred<void>();
    vi.mocked(client.apiDeleteMessage).mockReturnValue(d.promise);
    const p = useMessageStore.getState().requestDeleteMessage('c1', 'm1');
    useMessageStore.getState().reset();
    d.reject(new Error('500'));
    await expect(p).rejects.toThrow();
    expect(useToastStore.getState().addToast).not.toHaveBeenCalled();
  });

  // The success guards matter even when the new session reuses the same channel and
  // message id (e.g. the same user logs back in and the channel reloads): an old
  // edit or delete that resolves after the reset must not mutate the new copy.

  it('an edit that resolves after logout does not mutate the new session same-id message', async () => {
    const d = deferred<Message>();
    vi.mocked(client.apiEditMessage).mockReturnValue(d.promise);
    const p = useMessageStore.getState().editMessage('c1', 'm1', 'edited');
    useMessageStore.getState().reset(); // logout bumps sessionEpoch
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1), 'NEW-SESSION')] } });
    d.resolve(msg('m1', tISO(1), 'edited')); // the old edit finally resolves
    await p;
    expect(useMessageStore.getState().messages.c1[0].content).toBe('NEW-SESSION'); // not clobbered
  });

  it('a delete that resolves after logout does not remove the new session same-id message', async () => {
    const d = deferred<void>();
    vi.mocked(client.apiDeleteMessage).mockReturnValue(d.promise);
    const p = useMessageStore.getState().requestDeleteMessage('c1', 'm1');
    useMessageStore.getState().reset();
    useMessageStore.setState({ messages: { c1: [msg('m1', tISO(1), 'NEW-SESSION')] } });
    d.resolve();
    await p;
    expect(ids()).toEqual(['m1']); // the old delete did not remove the new session's copy
  });

  // --- Pagination loop guard (F34.3) --------------------------------------
  it('a full older page of only duplicates stops pagination instead of looping', async () => {
    const window = block('m', LIMIT, 1); // m0..m49 (ascending, m0 oldest)
    useMessageStore.setState({ messages: { c1: window }, hasMore: { c1: true } });
    // The server returns a full page that is entirely rows we already hold (e.g. a
    // cursor that fails to advance). The oldest loaded id does not change, so paging
    // again would request the same page forever.
    vi.mocked(client.apiGetMessages).mockResolvedValue(desc(window));
    await useMessageStore.getState().fetchMessages('c1', 'm0'); // load older, before the oldest
    expect(useMessageStore.getState().hasMore.c1).toBe(false); // stuck cursor -> stop, do not loop
    expect(ids().length).toBe(LIMIT); // nothing new prepended
  });

  it('keeps hasMore when a full new older page is all deleted by realtime during the fetch', async () => {
    useMessageStore.setState({ messages: { c1: block('w', 5, 100) }, hasMore: { c1: true } });
    const older = block('old', LIMIT, 1); // a full page of genuinely older, unseen messages
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      // Realtime deletes every fetched message mid-request -> reconciliation drops
      // them all, but older history still exists beyond this page.
      for (const m of older) useMessageStore.getState().deleteMessage('c1', m.id);
      return desc(older);
    });
    await useMessageStore.getState().fetchMessages('c1', 'w0');
    // Raw page advanced the cursor (new ids), so this is NOT end-of-history even
    // though zero rows survived reconciliation.
    expect(useMessageStore.getState().hasMore.c1).toBe(true);
    expect(ids()).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']); // nothing prepended (all deleted)
  });

  it('ends pagination on a duplicate page even if a cached row is realtime-deleted mid-fetch', async () => {
    const window = block('m', LIMIT, 1); // m0..m49, all loaded at request start
    useMessageStore.setState({ messages: { c1: window }, hasMore: { c1: true } });
    vi.mocked(client.apiGetMessages).mockImplementation(async () => {
      // A realtime delete removes a cached row mid-request, so it is absent from the
      // settlement cache -- but the fetched page still did not advance the cursor
      // relative to request start.
      useMessageStore.getState().deleteMessage('c1', 'm10');
      return desc(window); // the same page we already had
    });
    await useMessageStore.getState().fetchMessages('c1', 'm0');
    // Progress is judged against request-start state, so the deleted row must not
    // make this all-duplicate page look novel.
    expect(useMessageStore.getState().hasMore.c1).toBe(false);
  });
});
