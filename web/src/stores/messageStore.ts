import { create } from 'zustand';
import type { Message } from '../types';
import { apiGetMessages, apiSendMessage, apiEditMessage, apiDeleteMessage, linkAbortToSession } from '../api/client';
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
  // All keyed by channelId so a race (or an error) in one channel never gates or
  // clears another's. errorSeq = the fetch sequence that set a channel's error (a
  // success clears it only if at least as new); committedSeq = the highest
  // successfully-committed sequence (a failure publishes only if newer).
  error: Record<string, string | null>;
  errorSeq: Record<string, number>;
  committedSeq: Record<string, number>;
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
const LOAD_ERROR = 'Failed to load messages.';

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
  content?: Message; // latest content baseline (create, with edits merged in so it keeps attachments)
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
  // Field-level merge. The fetched copy is authoritative for author, reply preview,
  // and reactions (the server returns them, fresh). A realtime content op newer than
  // the fetch overrides only the content-bearing fields. Attachments are recovered
  // from a journal create because the List endpoint omits them (see F37) -- they are
  // immutable, so a create's copy is valid at any age. Then layer realtime reaction
  // patches recorded after the fetch started.
  let msg = fetched;
  if (entry.contentVer > startVer && entry.content) {
    msg = { ...msg, content: entry.content.content, editedAt: entry.content.editedAt, embeds: entry.content.embeds };
  }
  if (entry.content?.attachments?.length) {
    msg = { ...msg, attachments: entry.content.attachments };
  }
  for (const p of entry.reactions) {
    if (p.ver > startVer) msg = applyReaction(msg, p.emoji, p.userId, p.op);
  }
  return msg;
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
  // merge it onto the prior baseline so a create's attachments survive the edit.
  const content = isCreate ? message : prev?.content ? mergeEditFields(prev.content, message) : message;
  const next: JournalEntry = {
    ver: journalVer,
    ts: nowMs(),
    contentVer: journalVer,
    content,
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
  error: {},
  errorSeq: {},
  committedSeq: {},
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
      // Both non-merge loads own isLoading, but only an initial load establishes
      // the latest window, so only it may optimistically clear that window's error.
      // A pagination (older history) must leave an existing latest-window error be.
      ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: true } }),
      ...(isBase && !merge
        ? { error: { ...s.error, [channelId]: null }, errorSeq: { ...s.errorSeq, [channelId]: 0 } }
        : {}),
    }));

    // Backstop: a fetch that never settles must not pin protectFloor forever. After
    // a bounded lifetime we ABANDON it -- abort the HTTP request (which settles this
    // promise so awaiters/loading refs release), forbid it from committing (so a very
    // late stale response can't erase newer state), drop its journal protection, and
    // release a non-merge load's loading state so the UI doesn't hang.
    let abandoned = false;
    const controller = new AbortController();
    // Cancel this request on logout too; unlinked in finally so a completed request
    // leaves no listener on the session signal.
    const unlinkSession = linkAbortToSession(controller);
    const protectionTimer = setTimeout(() => {
      abandoned = true;
      controller.abort();
      set((s) => {
        if (sessionEpoch !== startSession) return {};
        const next = { ...s.activeFetches };
        delete next[mySeq];
        // Surface the base-load error (a Retry affordance) instead of staying
        // falsely empty -- but ONLY when no newer base fetch is still in flight and
        // the channel has nothing to fall back to. That way the Retry a user can
        // click never coexists with a healthy in-flight resync (whose fresh
        // response clicking Retry would discard), and it never loops. We never
        // auto-retry. A pagination just releases loading; a resync that still has
        // messages keeps them.
        const surfaceError =
          isBase &&
          mySeq >= (s.maxStartedBaseSeq[channelId] ?? mySeq) && // still the newest-started base -> none in flight
          mySeq >= (s.committedSeq[channelId] ?? 0) &&
          mySeq >= (s.errorSeq[channelId] ?? 0) &&
          (s.messages[channelId]?.length ?? 0) === 0; // nothing loaded to fall back to
        return {
          activeFetches: next,
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
          ...(surfaceError
            ? { error: { ...s.error, [channelId]: LOAD_ERROR }, errorSeq: { ...s.errorSeq, [channelId]: mySeq } }
            : {}),
        };
      });
    }, FETCH_PROTECTION_TIMEOUT_MS);

    try {
      const rawFetched = await apiGetMessages(channelId, before, MESSAGE_LIMIT, controller.signal);
      const fetched = Array.isArray(rawFetched) ? rawFetched : [];
      fetched.reverse(); // API returns DESC (newest first) -> ASC

      set((s) => {
        // A reset() during the fetch, or abandonment by the protection timeout,
        // invalidates this response entirely.
        if (sessionEpoch !== startSession || abandoned) return {};

        const existing = s.messages[channelId] || [];
        const existingById = new Map(existing.map((m) => [m.id, m]));

        const reconciledFetched: Message[] = [];
        for (const m of fetched) {
          const j = s.journal[m.id];
          let out: Message | null = !j || j.ver <= startVer ? m : reconcile(j, m, startVer);
          if (!out) continue; // deleted during the fetch
          // The List omits attachments (F37); if the fetched copy has none but the
          // loaded copy does, keep them -- a resync must not destroy attachments the
          // client already holds from a realtime create.
          const cur = existingById.get(out.id);
          if (!out.attachments?.length && cur?.attachments?.length) {
            out = { ...out, attachments: cur.attachments };
          }
          reconciledFetched.push(out);
        }

        if (before) {
          // Pagination. If the window was replaced/gapped since this started, its
          // older segment can no longer be trusted contiguous -> discard it.
          if ((s.windowEpoch[channelId] ?? 0) !== startEpoch) {
            return { isLoading: { ...s.isLoading, [channelId]: false } };
          }
          const existingIds = new Set(existing.map((m) => m.id));
          const older = reconciledFetched.filter((m) => !existingIds.has(m.id));
          // Pagination loads OLDER history; it does not refresh the latest window,
          // so it does NOT touch committedSeq or the load error -- a pagination
          // success must not suppress or clear a latest-window (base) failure.
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
          // Only a realtime content op (create/update) after the fetch started can
          // preserve a message the authoritative page omits -- a reaction patch
          // cannot supply a content baseline, so it must not resurrect a message an
          // empty/partial response says is gone.
          const touchedContent = j !== undefined && j.contentVer > startVer;
          if (touchedContent) {
            if (j.deletedVer > startVer && j.deletedVer > j.contentVer) continue; // deleted during fetch
            result.set(m.id, m); // realtime create/update during the fetch -> keep
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
          committedSeq: { ...s.committedSeq, [channelId]: Math.max(s.committedSeq[channelId] ?? 0, mySeq) },
          // Clear a raced request's error only if this success is at least as new.
          ...(mySeq >= (s.errorSeq[channelId] ?? 0)
            ? { error: { ...s.error, [channelId]: null }, errorSeq: { ...s.errorSeq, [channelId]: 0 } }
            : {}),
          ...(epochAdvanced
            ? { windowEpoch: { ...s.windowEpoch, [channelId]: (s.windowEpoch[channelId] ?? 0) + 1 } }
            : {}),
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, LOAD_ERROR);
      // A request begun before a reset, or abandoned by the protection timeout,
      // must not write into the (new/fresh) session.
      if (sessionEpoch === startSession && !abandoned) {
        set((s) => {
          // The error field is the LATEST-WINDOW load status, owned only by base
          // fetches (initial load / resync); a pagination loads older history and
          // never sets or clears it. A base failure is superseded only by newer base
          // activity: a newer base success, a newer base error, or a later-started
          // base fetch. committedSeq/errorSeq/maxStartedBaseSeq are all base-scoped.
          const superseded =
            mySeq < (s.committedSeq[channelId] ?? 0) ||
            mySeq < (s.errorSeq[channelId] ?? 0) ||
            mySeq < (s.maxStartedBaseSeq[channelId] ?? mySeq);
          return {
            ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
            ...(isBase && !superseded
              ? { error: { ...s.error, [channelId]: message }, errorSeq: { ...s.errorSeq, [channelId]: mySeq } }
              : {}),
          };
        });
      }
    } finally {
      // Deregister by unique id on every exit path (the timer backstop may have
      // done it already; deregister is idempotent and session-guarded). Unlink the
      // session listener so it never outlives the request.
      clearTimeout(protectionTimer);
      unlinkSession();
      deregister();
    }
  },

  editMessage: async (channelId: string, messageId: string, content: string) => {
    try {
      const updated = await apiEditMessage(channelId, messageId, content);
      get().updateMessage(channelId, updated);
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to edit message.');
      // error[channelId] is the latest-window LOAD status (base-owned); a mutation
      // failure surfaces via the thrown error the caller handles, not that field.
      throw new Error(errMsg);
    }
  },

  requestDeleteMessage: async (channelId: string, messageId: string) => {
    try {
      await apiDeleteMessage(channelId, messageId);
      get().deleteMessage(channelId, messageId);
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to delete message.');
      // error[channelId] is the latest-window LOAD status (base-owned); a mutation
      // failure surfaces via the thrown error the caller handles, not that field.
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
      // error[channelId] is the latest-window LOAD status (base-owned); a mutation
      // failure surfaces via the thrown error the caller handles, not that field.
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
      error: {},
      errorSeq: {},
      committedSeq: {},
      replyingTo: null,
    });
  },
}));
