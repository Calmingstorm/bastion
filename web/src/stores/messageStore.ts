import { create } from 'zustand';
import type { Message } from '../types';
import { apiGetMessages, apiSendMessage, apiEditMessage, apiDeleteMessage } from '../api/client';
import { extractErrorMessage } from '../utils/errors';
import { eventBus } from '../utils/eventBus';

interface MessageState {
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  // Internal: recent realtime deletes/updates (keyed by message id) used to
  // reconcile reconnect resyncs against changes that raced the fetch.
  recentEvents: Record<string, RecentEvent>;
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

// recentEvents lets a reconnect resync recognize realtime changes that landed
// during its in-flight fetch even for messages never loaded locally, so a stale
// HTTP page cannot resurrect a deleted message or hide an update. eventGen is a
// monotonic clock ("during the fetch" = gen > the gen captured at request start).
// The map is pruned by age and hard-capped, both keyed to eventGen order so a
// burst of unrelated events cannot evict an entry from a still-pending resync.
type RecentEvent =
  | { gen: number; ts: number; kind: 'delete' }
  | { gen: number; ts: number; kind: 'update'; message: Message };
let eventGen = 0;
const RECENT_MAX_AGE_MS = 60000;
const RECENT_CAP = 5000;
function recordEvent(
  current: Record<string, RecentEvent>,
  id: string,
  kind: 'delete' | 'update',
  message?: Message
): Record<string, RecentEvent> {
  eventGen += 1;
  const now = nowMs();
  const ev: RecentEvent =
    kind === 'update'
      ? { gen: eventGen, ts: now, kind: 'update', message: message as Message }
      : { gen: eventGen, ts: now, kind: 'delete' };
  const next: Record<string, RecentEvent> = { ...current, [id]: ev };
  let entries = Object.entries(next).filter(([, e]) => now - e.ts <= RECENT_MAX_AGE_MS);
  if (entries.length > RECENT_CAP) {
    entries.sort((a, b) => a[1].gen - b[1].gen);
    entries = entries.slice(entries.length - RECENT_CAP);
  }
  return Object.fromEntries(entries);
}
// nowMs is wrapped so pruning is deterministic under fake timers if needed.
function nowMs(): number {
  return Date.now();
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  hasMore: {},
  recentEvents: {},
  isLoading: {},
  error: null,
  replyingTo: null,

  setReplyingTo: (msg: Message | null) => set({ replyingTo: msg }),

  fetchMessages: async (channelId: string, before?: string, merge?: boolean) => {
    const state = get();

    // A merge resync must run even if a pagination (or another load) is already
    // in flight, so it is not gated by -- and does not touch -- isLoading.
    if (!merge && state.isLoading[channelId]) return;

    // Snapshot the message OBJECTS present when the request begins. On a merge
    // resync this lets us reconcile the fetched page against realtime changes by
    // reference identity (the store updates messages immutably): a row still ===
    // its start snapshot is unchanged since the request began.
    const startSnap = merge
      ? new Map((state.messages[channelId] || []).map((m) => [m.id, m]))
      : null;
    // Generation clock at request start: any realtime event with gen > startGen
    // touched its message during the fetch.
    const startGen = eventGen;

    if (!merge) {
      set((s) => ({
        isLoading: { ...s.isLoading, [channelId]: true },
        error: null,
      }));
    }

    try {
      const rawFetched = await apiGetMessages(channelId, before, MESSAGE_LIMIT);
      const fetched = Array.isArray(rawFetched) ? rawFetched : [];
      // API returns messages in DESC order (newest first); reverse to ASC (oldest first)
      fetched.reverse();

      set((s) => {
        const existing = s.messages[channelId] || [];

        if (before) {
          // Loading older messages: prepend (fetched is now ASC, so oldest first)
          const existingIds = new Set(existing.map((m) => m.id));
          const newMessages = fetched.filter((m) => !existingIds.has(m.id));
          return {
            messages: {
              ...s.messages,
              [channelId]: [...newMessages, ...existing],
            },
            hasMore: {
              ...s.hasMore,
              [channelId]: fetched.length === MESSAGE_LIMIT,
            },
            isLoading: { ...s.isLoading, [channelId]: false },
          };
        }

        // Reconnect resync: reconcile the fetched page against realtime changes
        // that landed during the fetch, per id, so a stale response neither undoes
        // live changes nor blocks server changes missed while disconnected:
        //   - changed during the fetch (current !== start snapshot) -> current wins;
        //   - deleted during the fetch (was in the snapshot, gone now) -> excluded;
        //   - unchanged since request start -> fetched wins (applies missed edits);
        //   - fetched-only / current-only rows -> unioned.
        // Runs even when live deletes emptied the list. hasMore is preserved.
        if (merge && startSnap) {
          const currentById = new Map(existing.map((m) => [m.id, m]));
          const result = new Map<string, Message>();
          for (const m of fetched) {
            const cur = currentById.get(m.id);
            const ev = s.recentEvents[m.id];
            const touched = ev !== undefined && ev.gen > startGen;
            // Deleted during the fetch -> stays deleted. Covers a message present
            // at start and gone now, and one never loaded here that got a realtime
            // delete during the fetch (via recentEvents).
            if ((startSnap.has(m.id) && cur === undefined) || (touched && ev.kind === 'delete')) {
              continue;
            }
            if (cur !== undefined && cur !== startSnap.get(m.id)) {
              result.set(m.id, cur); // changed while loaded during the fetch -> current wins
            } else if (touched && ev.kind === 'update') {
              result.set(m.id, ev.message); // updated during the fetch (even if unloaded)
            } else {
              result.set(m.id, m); // unchanged since start (or new) -> fetched wins
            }
          }
          for (const m of existing) {
            if (!result.has(m.id)) result.set(m.id, m); // history / live creates
          }
          const merged = Array.from(result.values()).sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
          // A merge resync does not own isLoading, so it leaves it untouched.
          return {
            messages: { ...s.messages, [channelId]: merged },
            hasMore: {
              ...s.hasMore,
              [channelId]: s.hasMore[channelId] ?? fetched.length === MESSAGE_LIMIT,
            },
          };
        }

        // Initial load
        return {
          messages: {
            ...s.messages,
            [channelId]: fetched,
          },
          hasMore: {
            ...s.hasMore,
            [channelId]: fetched.length === MESSAGE_LIMIT,
          },
          isLoading: { ...s.isLoading, [channelId]: false },
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load messages.');
      set((s) => ({
        // A merge resync does not own isLoading, so leave it untouched on error.
        isLoading: merge ? s.isLoading : { ...s.isLoading, [channelId]: false },
        error: message,
      }));
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
      // Deduplicate: don't add if message already exists
      if (existing.some((m) => m.id === message.id)) {
        return {};
      }
      return {
        messages: {
          ...state.messages,
          [channelId]: [...existing, message],
        },
      };
    });
  },

  updateMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId];
      // Always record the event (with content) -- even when the message is not
      // loaded here -- so an in-flight resync applies the update over a stale page.
      return {
        recentEvents: recordEvent(state.recentEvents, message.id, 'update', message),
        messages: existing
          ? { ...state.messages, [channelId]: existing.map((m) => (m.id === message.id ? message : m)) }
          : state.messages,
      };
    });
  },

  deleteMessage: (channelId: string, messageId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      // Always record the event -- even if the message is not loaded here -- so
      // an in-flight resync cannot resurrect it from a stale page.
      return {
        recentEvents: recordEvent(state.recentEvents, messageId, 'delete'),
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
      isLoading: {},
      error: null,
      replyingTo: null,
    });
  },
}));

