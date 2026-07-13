import { create } from 'zustand';
import type { Message } from '../types';
import { apiGetMessages, apiSendMessage, apiEditMessage, apiDeleteMessage } from '../api/client';
import { extractErrorMessage } from '../utils/errors';
import { eventBus } from '../utils/eventBus';

interface MessageState {
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  // Internal reconnect-reconciliation bookkeeping (see the block comment below).
  journal: Record<string, JournalEntry>;
  activeFetches: Record<number, number>;
  maxStartedBaseSeq: Record<string, number>;
  windowEpoch: Record<string, number>;
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

// --- Reconnect reconciliation model --------------------------------------------
//
// Reconciling a fetched page against realtime changes that raced it is a real
// distributed-systems problem. PROVENANCE, not object identity, decides who wins:
// a fetch write and a realtime write both produce new objects.
//
// journal: a per-message-id record of realtime/local MUTATIONS, composed so that
//   content and reactions are INDEPENDENT dimensions (a content edit must not drop
//   a reaction; a reaction must not revert a content edit):
//     - content (create/update) sets a version-stamped baseline;
//     - delete sets a version-stamped tombstone;
//     - reaction add/remove append version-stamped, set-based, idempotent patches.
//   Every mutation bumps the monotonic journalVer. A fetch commit NEVER writes the
//   journal, so a fetched copy can't masquerade as a mutation. Reconciling a
//   fetched message m at fetch-start version V: if a content op has ver > V its
//   baseline supersedes m's content (else m's content stands), then every reaction
//   patch with ver > V is layered on top; a tombstone newer than V (and any
//   content op) drops it.
// fetchSeq: a monotonic clock ticking once per fetch START. mySeq identifies a
//   fetch uniquely (deregistration) and orders competing latest-window fetches.
// maxStartedBaseSeq: per channel, the highest base-fetch seq that has STARTED. A
//   base fetch may commit only if it is still the newest-started one, so an
//   earlier-started response that resolves late cannot commit stale data.
// windowEpoch: per channel, bumped when a base commit replaces the cache or
//   declares a no-overlap gap; a pagination started against an older epoch is
//   discarded so it can't splice a stale history segment back in.
// sessionEpoch: bumped by reset(); no path of a request begun earlier may touch
//   the new session (commit, error, or deregistration).
// activeFetches: keyed by unique mySeq -> the fetch's start version. Pruning may
//   never drop a journal entry newer than the earliest active fetch's version.
type ReactionPatch = { ver: number; emoji: string; userId: string; op: 'add' | 'remove' };
type JournalEntry = {
  ver: number; // max version recorded (pruning/protection ordering)
  ts: number;
  contentVer: number; // version of the latest content op (0 = none yet)
  content?: Message; // latest content baseline
  deletedVer: number; // version of a delete op (0 = not deleted)
  reactions: ReactionPatch[]; // version-stamped reaction patches, in version order
};

let journalVer = 0;
let fetchSeq = 0;
let sessionEpoch = 0;
const RECENT_MAX_AGE_MS = 60000;
const RECENT_CAP = 5000;

// nowMs is wrapped so pruning is deterministic under fake timers in tests.
function nowMs(): number {
  return Date.now();
}

// Set-based reaction application: idempotent, so an optimistic local mutation and
// its later realtime echo cannot double-count. count always tracks users.length.
function applyReaction(m: Message, emoji: string, userId: string, op: 'add' | 'remove'): Message {
  const reactions = [...(m.reactions || [])];
  const idx = reactions.findIndex((r) => r.emoji === emoji);
  if (op === 'add') {
    if (idx >= 0) {
      if (!reactions[idx].users.includes(userId)) {
        const users = [...reactions[idx].users, userId];
        reactions[idx] = { ...reactions[idx], users, count: users.length };
      }
    } else {
      reactions.push({ emoji, count: 1, users: [userId] });
    }
  } else if (idx >= 0) {
    const users = reactions[idx].users.filter((u) => u !== userId);
    if (users.length === 0) reactions.splice(idx, 1);
    else reactions[idx] = { ...reactions[idx], users, count: users.length };
  }
  return { ...m, reactions };
}

// A MESSAGE_UPDATE (edit) carries only content-bearing fields (content, editedAt,
// embeds) -- the server's edit payload omits reactions, reply metadata, and
// attachments. Merge just those fields onto a baseline so a partial edit never
// erases the reactions/reply/attachments the baseline already holds.
function mergeEditFields(base: Message, update: Message): Message {
  return { ...base, content: update.content, editedAt: update.editedAt, embeds: update.embeds };
}

// Reconstruct the authoritative view of a message at fetch-start version startVer:
// content from the newest source (a realtime content op after start, else the
// fetched baseline), then every realtime reaction patch since start layered on.
// Returns null if the message was deleted after start (and not recreated).
function reconcile(entry: JournalEntry, fetched: Message, startVer: number): Message | null {
  if (entry.deletedVer > startVer && entry.deletedVer > entry.contentVer) return null;
  // A realtime content op newer than the fetch overrides only its content-bearing
  // fields; reactions/reply/attachments stay from the fetched baseline. Then layer
  // on realtime reaction patches recorded after the fetch started.
  let content = entry.contentVer > startVer && entry.content ? mergeEditFields(fetched, entry.content) : fetched;
  for (const p of entry.reactions) {
    if (p.ver > startVer) content = applyReaction(content, p.emoji, p.userId, p.op);
  }
  return content;
}

function protectFloorOf(activeFetches: Record<number, number>): number {
  const vers = Object.values(activeFetches);
  return vers.length ? Math.min(...vers) : Infinity;
}

// Prune journal entries by age and size, but never one an active fetch may still
// consume (ver > protectFloor). If everything left is protected we transiently
// exceed the cap -- bounded by the in-flight fetch's own lifetime -- rather than
// corrupt reconciliation.
function pruneJournal(
  journal: Record<string, JournalEntry>,
  protectFloor: number
): Record<string, JournalEntry> {
  const now = nowMs();
  let entries = Object.entries(journal).filter(
    ([, e]) => now - e.ts <= RECENT_MAX_AGE_MS || e.ver > protectFloor
  );
  if (entries.length > RECENT_CAP) {
    entries.sort((a, b) => a[1].ver - b[1].ver);
    const droppable = entries.filter(([, e]) => e.ver <= protectFloor);
    const protectedEntries = entries.filter(([, e]) => e.ver > protectFloor);
    const keepDroppable = Math.max(0, RECENT_CAP - protectedEntries.length);
    entries = [...droppable.slice(droppable.length - keepDroppable), ...protectedEntries];
  }
  return Object.fromEntries(entries);
}

function recordUpsert(
  journal: Record<string, JournalEntry>,
  id: string,
  message: Message,
  protectFloor: number
): Record<string, JournalEntry> {
  journalVer += 1;
  const prev = journal[id];
  // A content op sets a new baseline but PRESERVES accumulated reaction patches
  // (a content edit must not drop a reaction) and clears any prior tombstone.
  const next: JournalEntry = {
    ver: journalVer,
    ts: nowMs(),
    contentVer: journalVer,
    content: message,
    deletedVer: 0,
    // Keep only patches an in-flight fetch could still need (see recordReaction).
    reactions: (prev?.reactions || []).filter((p) => p.ver > protectFloor),
  };
  return pruneJournal({ ...journal, [id]: next }, protectFloor);
}

function recordDelete(
  journal: Record<string, JournalEntry>,
  id: string,
  protectFloor: number
): Record<string, JournalEntry> {
  journalVer += 1;
  const next: JournalEntry = {
    ver: journalVer,
    ts: nowMs(),
    contentVer: 0,
    deletedVer: journalVer,
    reactions: [],
  };
  return pruneJournal({ ...journal, [id]: next }, protectFloor);
}

function recordReaction(
  journal: Record<string, JournalEntry>,
  id: string,
  emoji: string,
  userId: string,
  op: 'add' | 'remove',
  protectFloor: number
): Record<string, JournalEntry> {
  const prev = journal[id];
  // A reaction to an already-deleted message is meaningless -- keep the tombstone.
  if (prev && prev.deletedVer > prev.contentVer) return journal;
  journalVer += 1;
  // Compact the patch list: a patch with ver <= protectFloor is older than every
  // in-flight fetch's start, so no active fetch will replay it (it is already in
  // their fetched baselines) -- drop it. This bounds one entry's patch list to the
  // active-fetch window, so reaction churn can't grow it without bound (with no
  // active fetch, protectFloor is Infinity and the list collapses entirely).
  const kept = (prev?.reactions || []).filter((p) => p.ver > protectFloor);
  const nextPatch: ReactionPatch = { ver: journalVer, emoji, userId, op };
  const reactions = journalVer > protectFloor ? [...kept, nextPatch] : kept;
  const next: JournalEntry = {
    ver: journalVer,
    ts: nowMs(),
    contentVer: prev?.contentVer ?? 0,
    content: prev?.content,
    deletedVer: prev?.deletedVer ?? 0,
    reactions,
  };
  return pruneJournal({ ...journal, [id]: next }, protectFloor);
}

// Strictly-newer test against the oldest fetched message, matching the server's
// created_at ordering. Boundary ties are treated as NOT within the window -- the
// conservative choice, since the server has no id tie-breaker so a tie could sit on
// either side of the 50-row cut; we never wrongly delete one.
function isWithinWindow(m: Message, oldest: Message): boolean {
  return new Date(m.createdAt).getTime() > new Date(oldest.createdAt).getTime();
}

function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => {
    const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  hasMore: {},
  journal: {},
  activeFetches: {},
  maxStartedBaseSeq: {},
  windowEpoch: {},
  isLoading: {},
  error: null,
  replyingTo: null,

  setReplyingTo: (msg: Message | null) => set({ replyingTo: msg }),

  fetchMessages: async (channelId: string, before?: string, merge?: boolean) => {
    const state = get();

    // A merge resync must run even if a pagination (or another load) is already in
    // flight, so it is not gated by -- and does not touch -- isLoading. Two
    // non-merge loads for the same channel still can't overlap (gated here).
    if (!merge && state.isLoading[channelId]) return;

    // Request-start provenance, captured now (NOT read from settlement state).
    const startVer = journalVer;
    const startIds = new Set((state.messages[channelId] || []).map((m) => m.id));
    const mySeq = (fetchSeq += 1);
    const isBase = !before;
    const startEpoch = state.windowEpoch[channelId] ?? 0;
    const startSession = sessionEpoch;

    set((s) => ({
      activeFetches: { ...s.activeFetches, [mySeq]: startVer },
      ...(isBase
        ? { maxStartedBaseSeq: { ...s.maxStartedBaseSeq, [channelId]: Math.max(s.maxStartedBaseSeq[channelId] ?? 0, mySeq) } }
        : {}),
      ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: true }, error: null }),
    }));

    try {
      const rawFetched = await apiGetMessages(channelId, before, MESSAGE_LIMIT);
      const fetched = Array.isArray(rawFetched) ? rawFetched : [];
      fetched.reverse(); // API returns DESC (newest first) -> ASC

      set((s) => {
        // A reset() during the fetch invalidates this response entirely.
        if (sessionEpoch !== startSession) return {};

        const existing = s.messages[channelId] || [];

        const reconciledFetched: Message[] = [];
        for (const m of fetched) {
          const j = s.journal[m.id];
          if (!j || j.ver <= startVer) {
            reconciledFetched.push(m); // untouched by realtime -> fetched copy is authoritative
            continue;
          }
          const r = reconcile(j, m, startVer);
          if (r) reconciledFetched.push(r);
        }

        if (before) {
          // Pagination. If the window was replaced/gapped since this started, its
          // older segment can no longer be trusted contiguous -> discard it.
          if ((s.windowEpoch[channelId] ?? 0) !== startEpoch) {
            return { isLoading: { ...s.isLoading, [channelId]: false } };
          }
          const existingIds = new Set(existing.map((m) => m.id));
          const older = reconciledFetched.filter((m) => !existingIds.has(m.id));
          return {
            messages: { ...s.messages, [channelId]: [...older, ...existing] },
            hasMore: { ...s.hasMore, [channelId]: fetched.length === MESSAGE_LIMIT },
            isLoading: { ...s.isLoading, [channelId]: false },
          };
        }

        // Latest-window fetch (initial load or resync). Commit only if still the
        // newest-STARTED base request for this channel.
        if (mySeq < (s.maxStartedBaseSeq[channelId] ?? mySeq)) {
          return merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } };
        }

        const fullPage = fetched.length === MESSAGE_LIMIT;
        let oldest: Message | null = null;
        for (const m of fetched) {
          if (oldest === null || new Date(m.createdAt).getTime() < new Date(oldest.createdAt).getTime()) {
            oldest = m;
          }
        }
        // Continuity is proven only if the fetched window shares an id with the
        // cache AS IT WAS AT REQUEST START -- a realtime create during the fetch
        // must not manufacture false overlap.
        const overlap = fetched.some((m) => startIds.has(m.id));

        const result = new Map<string, Message>(reconciledFetched.map((m) => [m.id, m]));
        for (const m of existing) {
          if (result.has(m.id)) continue;
          const j = s.journal[m.id];
          const touched = j !== undefined && j.ver > startVer;
          if (touched) {
            if (j.deletedVer > startVer && j.deletedVer > j.contentVer) continue; // deleted during fetch
            result.set(m.id, m); // realtime create/update/reaction during the fetch -> keep
            continue;
          }
          if (!fullPage) continue; // partial/empty page is authoritative for the whole channel -> drop
          if (oldest && isWithinWindow(m, oldest)) continue; // inside window, absent -> deleted -> drop
          if (merge && overlap) result.set(m.id, m); // contiguous history below the window -> keep
        }

        let newHasMore: boolean;
        let epochAdvanced: boolean;
        if (!fullPage) {
          newHasMore = false;
          epochAdvanced = true;
        } else if (merge && overlap) {
          newHasMore = s.hasMore[channelId] ?? true;
          epochAdvanced = false;
        } else {
          newHasMore = true;
          epochAdvanced = true;
        }

        return {
          messages: { ...s.messages, [channelId]: sortMessages(Array.from(result.values())) },
          hasMore: { ...s.hasMore, [channelId]: newHasMore },
          ...(epochAdvanced
            ? { windowEpoch: { ...s.windowEpoch, [channelId]: (s.windowEpoch[channelId] ?? 0) + 1 } }
            : {}),
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load messages.');
      // A request begun before a reset must not write into the new session.
      if (sessionEpoch === startSession) {
        set((s) => {
          // Obsolete requests clear their own loading but must not surface a stale
          // error over the fresh state: a base fetch superseded by a later-started
          // one, or a pagination whose window was replaced/gapped since it started.
          const superseded = isBase
            ? mySeq < (s.maxStartedBaseSeq[channelId] ?? mySeq)
            : (s.windowEpoch[channelId] ?? 0) !== startEpoch;
          return {
            ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
            ...(superseded ? {} : { error: message }),
          };
        });
      }
    } finally {
      // Deregister by unique id on every exit path; a reset already cleared the
      // registry, so skip touching the new session.
      if (sessionEpoch === startSession) {
        set((s) => {
          if (!(mySeq in s.activeFetches)) return {};
          const next = { ...s.activeFetches };
          delete next[mySeq];
          return { activeFetches: next };
        });
      }
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
      // Optimistic add (the WebSocket may also deliver it; addMessage dedupes).
      get().addMessage(channelId, message);
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
      const journal = recordUpsert(state.journal, message.id, message, protectFloorOf(state.activeFetches));
      if (existing.some((m) => m.id === message.id)) return { journal };
      return { journal, messages: { ...state.messages, [channelId]: [...existing, message] } };
    });
  },

  updateMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId];
      return {
        journal: recordUpsert(state.journal, message.id, message, protectFloorOf(state.activeFetches)),
        // A live edit is partial (content-only); merge its fields so the loaded
        // copy keeps its reactions/reply/attachments.
        messages: existing
          ? { ...state.messages, [channelId]: existing.map((m) => (m.id === message.id ? mergeEditFields(m, message) : m)) }
          : state.messages,
      };
    });
  },

  deleteMessage: (channelId: string, messageId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      return {
        journal: recordDelete(state.journal, messageId, protectFloorOf(state.activeFetches)),
        messages: existing
          ? { ...state.messages, [channelId]: existing.filter((m) => m.id !== messageId) }
          : state.messages,
      };
    });
  },

  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      const journal = recordReaction(state.journal, messageId, emoji, userId, 'add', protectFloorOf(state.activeFetches));
      if (!existing || !existing.some((m) => m.id === messageId)) return { journal };
      return {
        journal,
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === messageId ? applyReaction(m, emoji, userId, 'add') : m)),
        },
      };
    });
  },

  removeReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      const journal = recordReaction(state.journal, messageId, emoji, userId, 'remove', protectFloorOf(state.activeFetches));
      if (!existing || !existing.some((m) => m.id === messageId)) return { journal };
      return {
        journal,
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => (m.id === messageId ? applyReaction(m, emoji, userId, 'remove') : m)),
        },
      };
    });
  },

  reset: () => {
    sessionEpoch += 1; // invalidate any response begun before this reset
    set({
      messages: {},
      hasMore: {},
      journal: {},
      activeFetches: {},
      maxStartedBaseSeq: {},
      windowEpoch: {},
      isLoading: {},
      error: null,
      replyingTo: null,
    });
  },
}));
