import { create } from 'zustand';
import type { Message } from '../types';
import { apiGetMessages, apiSendMessage, apiEditMessage, apiDeleteMessage } from '../api/client';
import { extractErrorMessage } from '../utils/errors';
import { eventBus } from '../utils/eventBus';

interface MessageState {
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  // Internal: recent realtime creates/updates/deletes (keyed by message id) used
  // to reconcile any in-flight fetch against changes that raced it.
  recentEvents: Record<string, RecentEvent>;
  // Internal: start generations of every in-flight fetch. Pruning must never drop
  // an event one of these could still consume.
  activeFetchGens: number[];
  // Internal: per-channel start sequence of the last-applied "latest window"
  // fetch (initial load or resync), so an earlier-started such response cannot
  // clobber a later-started one that already settled.
  appliedBaseSeq: Record<string, number>;
  isLoading: Record<string, boolean>;
  error: string | null;
  replyingTo: Message | null;
  setReplyingTo: (msg: Message | null) => void;
  fetchMessages: (channelId: string, before?: string, merge?: boolean) => Promise<void>;
  sendMessage: (channelId: string, content: string, replyToId?: string) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteMessage: (channelId: string, messageId: string) => Promise<void>;
  addMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, message: Message) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => void;
  removeReaction: (channelId: string, messageId: string, emoji: string, userId: string) => void;
  reset: () => void;
}

const MESSAGE_LIMIT = 50;

// recentEvents lets any in-flight fetch recognize realtime changes that landed
// during it -- even for messages never loaded locally -- so a stale HTTP page
// cannot resurrect a deleted message, drop a live create, or hide an update.
// eventGen is a monotonic clock: "during the fetch" == gen > the gen captured at
// the fetch's start.
//
// A 'delete' tombstone excludes the id; an 'upsert' (create or edit) carries the
// authoritative message. Pruning (age + size) is generation-aware so it can only
// discard events no still-active fetch could consume (see recordEvent).
type RecentEvent =
  | { gen: number; ts: number; kind: 'delete' }
  | { gen: number; ts: number; kind: 'upsert'; message: Message };

let eventGen = 0;
// A separate monotonic clock ticking once per fetch START, used only to order
// "latest window" fetches (initial load / resync) by when they began -- distinct
// from eventGen (which orders realtime events). Two base fetches with no realtime
// event between their starts must still be ordered, which a shared clock can't do.
let fetchSeq = 0;
const RECENT_MAX_AGE_MS = 60000;
const RECENT_CAP = 5000;

// nowMs is wrapped so pruning is deterministic under fake timers in tests.
function nowMs(): number {
  return Date.now();
}

// Record a realtime event and prune stale entries. protectFloor is the earliest
// start generation of any in-flight fetch (or Infinity when none are active):
// an event with gen > protectFloor might still be consumed by a pending fetch,
// so age and size limits are forbidden from discarding it. This keeps a slow
// resync's needed events alive no matter how many unrelated events arrive.
function recordEvent(
  current: Record<string, RecentEvent>,
  id: string,
  kind: 'delete' | 'upsert',
  message: Message | undefined,
  protectFloor: number
): Record<string, RecentEvent> {
  eventGen += 1;
  const now = nowMs();
  const ev: RecentEvent =
    kind === 'upsert'
      ? { gen: eventGen, ts: now, kind: 'upsert', message: message as Message }
      : { gen: eventGen, ts: now, kind: 'delete' };
  const next: Record<string, RecentEvent> = { ...current, [id]: ev };

  // Age prune: drop entries older than the window UNLESS an active fetch may need
  // them.
  let entries = Object.entries(next).filter(
    ([, e]) => now - e.ts <= RECENT_MAX_AGE_MS || e.gen > protectFloor
  );
  // Size prune: if still over cap, drop oldest-by-generation first, but never an
  // entry an active fetch may need. (If everything left is protected we exceed the
  // cap transiently -- bounded by the in-flight fetch's own lifetime.)
  if (entries.length > RECENT_CAP) {
    entries.sort((a, b) => a[1].gen - b[1].gen);
    const droppable = entries.filter(([, e]) => e.gen <= protectFloor);
    const protectedEntries = entries.filter(([, e]) => e.gen > protectFloor);
    const keepDroppable = Math.max(0, RECENT_CAP - protectedEntries.length);
    entries = [...droppable.slice(droppable.length - keepDroppable), ...protectedEntries];
  }
  return Object.fromEntries(entries);
}

// The earliest generation any in-flight fetch could still need. Events at or
// below it are safe to prune; above it are protected.
function protectFloorOf(activeFetchGens: number[]): number {
  return activeFetchGens.length ? Math.min(...activeFetchGens) : Infinity;
}

function removeOne(arr: number[], value: number): number[] {
  const i = arr.indexOf(value);
  return i < 0 ? arr : [...arr.slice(0, i), ...arr.slice(i + 1)];
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  hasMore: {},
  recentEvents: {},
  activeFetchGens: [],
  appliedBaseSeq: {},
  isLoading: {},
  error: null,
  replyingTo: null,

  setReplyingTo: (msg: Message | null) => set({ replyingTo: msg }),

  fetchMessages: async (channelId: string, before?: string, merge?: boolean) => {
    const state = get();

    // A merge resync must run even if a pagination (or another load) is already
    // in flight, so it is not gated by -- and does not touch -- isLoading. Two
    // non-merge loads for the same channel still can't overlap (the second is
    // gated here); a resync coexisting with either is reconciled below.
    if (!merge && state.isLoading[channelId]) return;

    // Snapshot the message OBJECTS present when the request begins (merge only).
    // The store updates messages immutably, so a row still === its start snapshot
    // is unchanged since the request began -- this catches changes with no
    // recentEvents entry, e.g. reactions.
    const startSnap = merge
      ? new Map((state.messages[channelId] || []).map((m) => [m.id, m]))
      : null;
    // Generation clock at request start: any realtime event with gen > startGen
    // touched its message during this fetch.
    const startGen = eventGen;
    // Fetch-start sequence, used to order competing latest-window fetches.
    const mySeq = (fetchSeq += 1);

    // Register this fetch so pruning protects the events it may still need, and
    // (for non-merge) flip isLoading on.
    set((s) => ({
      activeFetchGens: [...s.activeFetchGens, startGen],
      ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: true }, error: null }),
    }));

    try {
      const rawFetched = await apiGetMessages(channelId, before, MESSAGE_LIMIT);
      const fetched = Array.isArray(rawFetched) ? rawFetched : [];
      // API returns messages in DESC order (newest first); reverse to ASC (oldest first)
      fetched.reverse();

      set((s) => {
        const existing = s.messages[channelId] || [];

        // Reconcile one fetched message against realtime events that landed after
        // this fetch started. Returns the message to apply, or null to drop it.
        const reconcileFetched = (m: Message): Message | null => {
          const ev = s.recentEvents[m.id];
          const touched = ev !== undefined && ev.gen > startGen;
          if (touched && ev.kind === 'delete') return null; // deleted during the fetch
          if (touched && ev.kind === 'upsert') return ev.message; // created/edited during the fetch
          return m; // untouched by realtime -> the fetched copy is authoritative
        };

        if (before) {
          // Pagination: prepend older messages. Reconcile each against realtime
          // events (so a page fetched before a delete cannot resurrect it), then
          // add only ids not already present. Never touches the latest window.
          const existingIds = new Set(existing.map((m) => m.id));
          const older: Message[] = [];
          for (const m of fetched) {
            const r = reconcileFetched(m);
            if (r && !existingIds.has(r.id)) older.push(r);
          }
          return {
            messages: { ...s.messages, [channelId]: [...older, ...existing] },
            hasMore: { ...s.hasMore, [channelId]: fetched.length === MESSAGE_LIMIT },
            isLoading: { ...s.isLoading, [channelId]: false },
          };
        }

        // Latest-window fetch (initial load or reconnect resync). If a
        // later-started such fetch already applied for this channel, this response
        // is stale -> drop it rather than clobber the newer state.
        const appliedSeq = s.appliedBaseSeq[channelId] ?? 0;
        if (mySeq < appliedSeq) {
          // Release isLoading for a superseded non-merge load; a merge doesn't own it.
          return merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } };
        }

        // Reconcile the fetched page per id, so a stale response neither undoes
        // live changes nor blocks server changes missed while disconnected:
        //   - deleted during the fetch (tombstone, or gone from a merge snapshot)
        //     -> excluded;
        //   - changed while loaded during the fetch (reaction etc., merge only)
        //     -> current wins;
        //   - created/edited during the fetch -> the realtime copy wins;
        //   - otherwise -> fetched wins (applies edits missed while disconnected).
        const currentById = new Map(existing.map((m) => [m.id, m]));
        const result = new Map<string, Message>();
        for (const m of fetched) {
          const cur = currentById.get(m.id);
          // A message present in the merge start-snapshot but gone now was deleted
          // during the fetch (covers deletes that recorded no event).
          if (merge && startSnap && startSnap.has(m.id) && cur === undefined) continue;
          const reconciled = reconcileFetched(m);
          if (reconciled === null) continue; // deleted during the fetch
          if (merge && startSnap && cur !== undefined && cur !== startSnap.get(m.id)) {
            result.set(m.id, cur); // changed while loaded during the fetch -> current wins
          } else {
            result.set(m.id, reconciled);
          }
        }
        // Preserve existing messages the fetched page couldn't supersede.
        for (const m of existing) {
          if (result.has(m.id)) continue;
          if (merge) {
            result.set(m.id, m); // resync keeps scrolled-in history and live creates
          } else {
            // Initial load establishes a fresh window, but must not drop a message
            // created/edited by realtime during its fetch.
            const ev = s.recentEvents[m.id];
            if (ev !== undefined && ev.gen > startGen && ev.kind === 'upsert') {
              result.set(m.id, m);
            }
          }
        }
        const merged = Array.from(result.values()).sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        return {
          messages: { ...s.messages, [channelId]: merged },
          appliedBaseSeq: { ...s.appliedBaseSeq, [channelId]: mySeq },
          hasMore: merge
            ? { ...s.hasMore, [channelId]: s.hasMore[channelId] ?? fetched.length === MESSAGE_LIMIT }
            : { ...s.hasMore, [channelId]: fetched.length === MESSAGE_LIMIT },
          // A merge resync does not own isLoading; an initial load clears it.
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load messages.');
      set((s) => ({
        // A merge resync does not own isLoading, so leave it untouched on error.
        isLoading: merge ? s.isLoading : { ...s.isLoading, [channelId]: false },
        error: message,
      }));
    } finally {
      // Deregister this fetch; pruning may now reclaim events only it protected.
      set((s) => ({ activeFetchGens: removeOne(s.activeFetchGens, startGen) }));
    }
  },

  editMessage: async (channelId: string, messageId: string, content: string) => {
    try {
      const updated = await apiEditMessage(channelId, messageId, content);
      get().updateMessage(channelId, updated);
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to edit message.');
      set({ error: errMsg });
      throw new Error(errMsg);
    }
  },

  requestDeleteMessage: async (channelId: string, messageId: string) => {
    try {
      await apiDeleteMessage(channelId, messageId);
      get().deleteMessage(channelId, messageId);
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to delete message.');
      set({ error: errMsg });
      throw new Error(errMsg);
    }
  },

  sendMessage: async (channelId: string, content: string, replyToId?: string) => {
    try {
      const message = await apiSendMessage(channelId, content, replyToId);
      // Add the message optimistically (the WebSocket might also deliver it,
      // but addMessage deduplicates)
      get().addMessage(channelId, message);
      // Signal message list to scroll to bottom for own messages
      eventBus.emit('bastion:message-sent');
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to send message.');
      set({ error: errMsg });
      throw new Error(errMsg);
    }
  },

  addMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId] || [];
      // Record the create so an in-flight fetch whose page predates it does not
      // drop it. (Deduplicates below; the event is recorded regardless so a resync
      // that started before this create still sees it.)
      const recentEvents = recordEvent(
        state.recentEvents,
        message.id,
        'upsert',
        message,
        protectFloorOf(state.activeFetchGens)
      );
      if (existing.some((m) => m.id === message.id)) {
        return { recentEvents };
      }
      return {
        recentEvents,
        messages: { ...state.messages, [channelId]: [...existing, message] },
      };
    });
  },

  updateMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId];
      // Always record the event (with content) -- even when the message is not
      // loaded here -- so an in-flight resync applies the update over a stale page.
      return {
        recentEvents: recordEvent(
          state.recentEvents,
          message.id,
          'upsert',
          message,
          protectFloorOf(state.activeFetchGens)
        ),
        messages: existing
          ? { ...state.messages, [channelId]: existing.map((m) => (m.id === message.id ? message : m)) }
          : state.messages,
      };
    });
  },

  deleteMessage: (channelId: string, messageId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      // Always record the tombstone -- even if the message is not loaded here --
      // so an in-flight resync cannot resurrect it from a stale page.
      return {
        recentEvents: recordEvent(
          state.recentEvents,
          messageId,
          'delete',
          undefined,
          protectFloorOf(state.activeFetchGens)
        ),
        messages: existing
          ? { ...state.messages, [channelId]: existing.filter((m) => m.id !== messageId) }
          : state.messages,
      };
    });
  },

  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      if (!existing) return {};
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...(m.reactions || [])];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            if (idx >= 0) {
              if (!reactions[idx].users.includes(userId)) {
                reactions[idx] = {
                  ...reactions[idx],
                  count: reactions[idx].count + 1,
                  users: [...reactions[idx].users, userId],
                };
              }
            } else {
              reactions.push({ emoji, count: 1, users: [userId] });
            }
            return { ...m, reactions };
          }),
        },
      };
    });
  },

  removeReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      if (!existing) return {};
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = (m.reactions || [])
              .map((r) => {
                if (r.emoji !== emoji) return r;
                const users = r.users.filter((u) => u !== userId);
                return { ...r, count: users.length, users };
              })
              .filter((r) => r.count > 0);
            return { ...m, reactions };
          }),
        },
      };
    });
  },

  reset: () => {
    set({
      messages: {},
      hasMore: {},
      recentEvents: {},
      activeFetchGens: [],
      appliedBaseSeq: {},
      isLoading: {},
      error: null,
      replyingTo: null,
    });
  },
}));
