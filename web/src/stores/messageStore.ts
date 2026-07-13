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
  // Fetch sequence that set the current error; a success clears the error only if
  // it is at least as new, so an older success can't erase a newer failure.
  errorSeq: number;
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
  fullContent: boolean; // true if the latest content op was a full create (vs a partial edit)
  deletedVer: number; // version of a delete op (0 = not deleted)
  reactions: ReactionPatch[]; // version-stamped reaction patches, in version order
};

let journalVer = 0;
let fetchSeq = 0;
let sessionEpoch = 0;
const RECENT_MAX_AGE_MS = 60000;
const RECENT_CAP = 5000;
// A fetch that never settles (the client sets no request timeout) would pin
// protectFloor forever and let its stale response commit arbitrarily late. After
// this long we ABANDON it: it can no longer commit, and its journal protection is
// dropped so pruning proceeds. Set well beyond RECENT_MAX_AGE_MS so it only fires
// for genuinely stuck fetches -- a real fetch resolves in a few seconds. This
// bounds one entry's live patch list by lifetime rather than truncating it.
const FETCH_PROTECTION_TIMEOUT_MS = 120000;

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
  // A realtime content op newer than the fetch supersedes it. A full baseline
  // (descends from a create) is authoritative for content AND attachments/reply,
  // but its reactions may be stale, so reactions come from the fetched copy. A
  // partial-edit-only baseline overrides just its content-bearing fields onto the
  // fetched copy. Either way, layer on realtime reaction patches after fetch start.
  let content = fetched;
  if (entry.contentVer > startVer && entry.content) {
    content = entry.fullContent
      ? { ...entry.content, reactions: fetched.reactions }
      : mergeEditFields(fetched, entry.content);
  }
  for (const p of entry.reactions) {
    if (p.ver > startVer) content = applyReaction(content, p.emoji, p.userId, p.op);
  }
  return content;
}

function protectFloorOf(activeFetches: Record<number, number>): number {
  const vers = Object.values(activeFetches);
  return vers.length ? Math.min(...vers) : Infinity;
}

// Keep only reaction patches an in-flight fetch could still replay: a patch with
// ver <= protectFloor is older than every active fetch's start, so it is already
// in their fetched baselines. This is lossless -- an active fetch's required
// evidence is never truncated; growth is bounded by fetch lifetime (a stuck fetch
// is abandoned, see FETCH_PROTECTION_TIMEOUT_MS), and with no active fetch
// protectFloor is Infinity so the list collapses entirely.
function boundPatches(patches: ReactionPatch[], protectFloor: number): ReactionPatch[] {
  return patches.filter((p) => p.ver > protectFloor);
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
  protectFloor: number,
  isCreate: boolean
): Record<string, JournalEntry> {
  journalVer += 1;
  const prev = journal[id];
  // A content op sets a new baseline but PRESERVES accumulated reaction patches
  // (a content edit must not drop a reaction) and clears any prior tombstone.
  // A create is a full message. An edit is partial (content-bearing fields only):
  // merge it onto the prior baseline so a create's attachments/reply survive, and
  // keep the baseline's fullness (full iff it still descends from a create).
  const content = isCreate ? message : prev?.content ? mergeEditFields(prev.content, message) : message;
  const fullContent = isCreate ? true : prev?.content ? prev.fullContent : false;
  const next: JournalEntry = {
    ver: journalVer,
    ts: nowMs(),
    contentVer: journalVer,
    content,
    fullContent,
    deletedVer: 0,
    reactions: boundPatches(prev?.reactions || [], protectFloor),
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
    fullContent: false,
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
  // boundPatches drops patches older than every in-flight fetch's start (already
  // in their baselines) and hard-caps the survivors. With no active fetch,
  // protectFloor is Infinity and the list collapses to empty.
  const next: JournalEntry = {
    ver: journalVer,
    ts: nowMs(),
    contentVer: prev?.contentVer ?? 0,
    content: prev?.content,
    fullContent: prev?.fullContent ?? false,
    deletedVer: prev?.deletedVer ?? 0,
    reactions: boundPatches([...(prev?.reactions || []), { ver: journalVer, emoji, userId, op }], protectFloor),
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
  errorSeq: 0,
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

    const deregister = () =>
      set((s) => {
        if (sessionEpoch !== startSession || !(mySeq in s.activeFetches)) return {};
        const next = { ...s.activeFetches };
        delete next[mySeq];
        return { activeFetches: next };
      });

    set((s) => ({
      activeFetches: { ...s.activeFetches, [mySeq]: startVer },
      ...(isBase
        ? { maxStartedBaseSeq: { ...s.maxStartedBaseSeq, [channelId]: Math.max(s.maxStartedBaseSeq[channelId] ?? 0, mySeq) } }
        : {}),
      ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: true }, error: null }),
    }));

    // Backstop: a fetch that never settles must not pin protectFloor forever. After
    // a bounded lifetime we ABANDON it -- it may no longer commit (so a very late
    // stale response can't erase newer state), its journal protection is dropped,
    // and a non-merge load releases its loading state so the UI doesn't hang.
    let abandoned = false;
    const protectionTimer = setTimeout(() => {
      abandoned = true;
      set((s) => {
        if (sessionEpoch !== startSession) return {};
        const next = { ...s.activeFetches };
        delete next[mySeq];
        return {
          activeFetches: next,
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
        };
      });
    }, FETCH_PROTECTION_TIMEOUT_MS);

    try {
      const rawFetched = await apiGetMessages(channelId, before, MESSAGE_LIMIT);
      const fetched = Array.isArray(rawFetched) ? rawFetched : [];
      fetched.reverse(); // API returns DESC (newest first) -> ASC

      set((s) => {
        // A reset() during the fetch, or abandonment by the protection timeout,
        // invalidates this response entirely.
        if (sessionEpoch !== startSession || abandoned) return {};

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
            // Clear a raced request's error only if this success is at least as new.
            ...(mySeq >= s.errorSeq ? { error: null, errorSeq: 0 } : {}),
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
          // Clear a raced request's error only if this success is at least as new.
          ...(mySeq >= s.errorSeq ? { error: null, errorSeq: 0 } : {}),
          ...(epochAdvanced
            ? { windowEpoch: { ...s.windowEpoch, [channelId]: (s.windowEpoch[channelId] ?? 0) + 1 } }
            : {}),
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load messages.');
      // A request begun before a reset, or abandoned by the protection timeout,
      // must not write into the (new/fresh) session.
      if (sessionEpoch === startSession && !abandoned) {
        set((s) => {
          // Obsolete requests clear their own loading but must not surface a stale
          // error over the fresh state: a base fetch superseded by a later-started
          // one, or a pagination whose window was replaced/gapped since it started.
          const superseded = isBase
            ? mySeq < (s.maxStartedBaseSeq[channelId] ?? mySeq)
            : (s.windowEpoch[channelId] ?? 0) !== startEpoch;
          return {
            ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
            // Stamp the error with this fetch's sequence so an older success can't clear it.
            ...(superseded ? {} : { error: message, errorSeq: mySeq }),
          };
        });
      }
    } finally {
      // Deregister by unique id on every exit path (the timer backstop may have
      // done it already; deregister is idempotent and session-guarded).
      clearTimeout(protectionTimer);
      deregister();
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
      const journal = recordUpsert(state.journal, message.id, message, protectFloorOf(state.activeFetches), true);
      if (existing.some((m) => m.id === message.id)) return { journal };
      return { journal, messages: { ...state.messages, [channelId]: [...existing, message] } };
    });
  },

  updateMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId];
      return {
        journal: recordUpsert(state.journal, message.id, message, protectFloorOf(state.activeFetches), false),
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
      errorSeq: 0,
      replyingTo: null,
    });
  },
}));
