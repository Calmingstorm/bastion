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
  activeFetchVers: number[];
  appliedBaseSeq: Record<string, number>;
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
// distributed-systems problem. The load-bearing idea is that PROVENANCE, not
// object identity, decides who wins: a fetch write and a realtime write both
// produce new objects, so identity cannot tell them apart.
//
// journal: a per-message-id log of realtime/local MUTATIONS (create/update ->
//   upsert; delete -> tombstone; reaction add/remove -> an ordered, idempotent,
//   set-based patch applied on top of a baseline). Every mutation bumps the
//   monotonic journalVer. A fetch commit NEVER writes the journal, so a fetched
//   copy can never masquerade as a mutation. "Changed during this fetch" == a
//   journal entry with ver > the journalVer captured at the fetch's start.
// fetchSeq: a separate monotonic clock ticking once per fetch START, used only to
//   order competing latest-window fetches (initial load / resync).
// windowEpoch: per channel, bumped whenever a base response REPLACES the cache or
//   declares a no-overlap gap. A pagination that started against an older epoch is
//   discarded so it cannot splice a stale history segment back in.
// sessionEpoch: bumped by reset(); a response begun before a reset cannot commit.
// activeFetchVers: start versions of every in-flight fetch; pruning may never drop
//   a journal entry newer than the earliest of these (a slow fetch still needs it).
type ReactionPatch = { emoji: string; userId: string; op: 'add' | 'remove' };
type JournalEntry = {
  ver: number;
  ts: number;
  kind: 'upsert' | 'delete';
  // Materialized realtime state for an upsert whose baseline is known.
  message?: Message;
  // Reaction patches awaiting a baseline (the message was not loaded when they
  // arrived); applied to a fetched copy if/when one appears.
  patches?: ReactionPatch[];
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

function applyPatches(m: Message, patches: ReactionPatch[] | undefined): Message {
  let out = m;
  for (const p of patches || []) out = applyReaction(out, p.emoji, p.userId, p.op);
  return out;
}

// The earliest generation any in-flight fetch could still need; events at or below
// it are safe to prune, above it are protected.
function protectFloorOf(activeFetchVers: number[]): number {
  return activeFetchVers.length ? Math.min(...activeFetchVers) : Infinity;
}

// Prune journal entries by age and size, but never one an active fetch may still
// consume (gen > protectFloor). If everything left is protected we transiently
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
  // A materialized upsert supersedes any pending patches for this id.
  const next = { ...journal, [id]: { ver: journalVer, ts: nowMs(), kind: 'upsert' as const, message } };
  return pruneJournal(next, protectFloor);
}

function recordDelete(
  journal: Record<string, JournalEntry>,
  id: string,
  protectFloor: number
): Record<string, JournalEntry> {
  journalVer += 1;
  const next = { ...journal, [id]: { ver: journalVer, ts: nowMs(), kind: 'delete' as const } };
  return pruneJournal(next, protectFloor);
}

function recordReaction(
  journal: Record<string, JournalEntry>,
  id: string,
  patch: ReactionPatch,
  baseline: Message | undefined,
  protectFloor: number
): Record<string, JournalEntry> {
  const entry = journal[id];
  // A reaction to an already-deleted message is meaningless -- keep the tombstone.
  if (entry && entry.kind === 'delete') return journal;
  journalVer += 1;
  const base = entry?.message ?? baseline;
  let value: JournalEntry;
  if (base !== undefined) {
    // Baseline known -> materialize the reacted message; drop now-subsumed patches.
    value = { ver: journalVer, ts: nowMs(), kind: 'upsert', message: applyReaction(base, patch.emoji, patch.userId, patch.op) };
  } else {
    // No baseline yet -> retain the ordered patch to replay onto a future fetch.
    value = { ver: journalVer, ts: nowMs(), kind: 'upsert', patches: [...(entry?.patches || []), patch] };
  }
  return pruneJournal({ ...journal, [id]: value }, protectFloor);
}

// Strictly-newer test against the oldest fetched message, matching the server's
// created_at ordering. Boundary ties (equal created_at) are treated as NOT within
// the window -- the conservative choice, since the server has no id tie-breaker so
// a tie could sit on either side of the 50-row cut; we never wrongly delete one.
function isWithinWindow(m: Message, oldest: Message): boolean {
  return new Date(m.createdAt).getTime() > new Date(oldest.createdAt).getTime();
}

function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => {
    const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function removeOne(arr: number[], value: number): number[] {
  const i = arr.indexOf(value);
  return i < 0 ? arr : [...arr.slice(0, i), ...arr.slice(i + 1)];
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  hasMore: {},
  journal: {},
  activeFetchVers: [],
  appliedBaseSeq: {},
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

    // Request-start provenance. IDs and versions are captured now, NOT read from
    // settlement state, so a realtime change during the fetch can't rewrite the
    // basis on which we reconcile.
    const startVer = journalVer;
    const startIds = new Set((state.messages[channelId] || []).map((m) => m.id));
    const mySeq = (fetchSeq += 1);
    const startEpoch = state.windowEpoch[channelId] ?? 0;
    const startSession = sessionEpoch;

    set((s) => ({
      activeFetchVers: [...s.activeFetchVers, startVer],
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
        const currentById = new Map(existing.map((m) => [m.id, m]));

        // Reconcile one fetched message against realtime mutations recorded AFTER
        // this fetch started. Provenance (journal ver > startVer), never identity.
        const reconcileFetched = (m: Message): Message | null => {
          const j = s.journal[m.id];
          const touched = j !== undefined && j.ver > startVer;
          if (!touched) return m; // untouched by realtime -> fetched copy is authoritative
          if (j.kind === 'delete') return null; // deleted during the fetch
          const cur = currentById.get(m.id);
          if (cur !== undefined) return cur; // loaded copy already carries the realtime state
          if (j.message !== undefined) return j.message; // materialized realtime create/update
          return applyPatches(m, j.patches); // reaction patch(es) onto the fetched baseline
        };

        const reconciledFetched: Message[] = [];
        for (const m of fetched) {
          const r = reconcileFetched(m);
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
        // newest-started base request for this channel.
        if (mySeq < (s.appliedBaseSeq[channelId] ?? 0)) {
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
          const touchedUpsert = j !== undefined && j.ver > startVer && j.kind === 'upsert';
          if (touchedUpsert) {
            result.set(m.id, m); // realtime create/update during the fetch -> keep
            continue;
          }
          if (!fullPage) continue; // partial/empty page is authoritative for the whole channel -> drop
          if (oldest && isWithinWindow(m, oldest)) continue; // inside window, absent -> deleted -> drop
          if (merge && overlap) result.set(m.id, m); // contiguous history below the window -> keep
          // else: gap (full/no-overlap) or fresh initial load -> drop the old segment
        }

        // hasMore + whether this commit invalidates in-flight paginations.
        let newHasMore: boolean;
        let epochAdvanced: boolean;
        if (!fullPage) {
          newHasMore = false; // reached channel start
          epochAdvanced = true; // cache authoritatively replaced
        } else if (merge && overlap) {
          newHasMore = s.hasMore[channelId] ?? true; // continuity -> preserve prior provenance
          epochAdvanced = false;
        } else {
          newHasMore = true; // gap/fresh window -> scroll can rebuild history
          epochAdvanced = true;
        }

        return {
          messages: { ...s.messages, [channelId]: sortMessages(Array.from(result.values())) },
          appliedBaseSeq: { ...s.appliedBaseSeq, [channelId]: mySeq },
          hasMore: { ...s.hasMore, [channelId]: newHasMore },
          ...(epochAdvanced
            ? { windowEpoch: { ...s.windowEpoch, [channelId]: (s.windowEpoch[channelId] ?? 0) + 1 } }
            : {}),
          ...(merge ? {} : { isLoading: { ...s.isLoading, [channelId]: false } }),
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load messages.');
      set((s) => ({
        isLoading: merge ? s.isLoading : { ...s.isLoading, [channelId]: false },
        error: message,
      }));
    } finally {
      // Deregister on every exit path (success, error, discard); pruning may now
      // reclaim events only this fetch protected.
      set((s) => ({ activeFetchVers: removeOne(s.activeFetchVers, startVer) }));
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
      // Record the create so an in-flight fetch whose page predates it keeps it.
      const journal = recordUpsert(
        state.journal,
        message.id,
        message,
        protectFloorOf(state.activeFetchVers)
      );
      if (existing.some((m) => m.id === message.id)) return { journal };
      return { journal, messages: { ...state.messages, [channelId]: [...existing, message] } };
    });
  },

  updateMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId];
      return {
        journal: recordUpsert(state.journal, message.id, message, protectFloorOf(state.activeFetchVers)),
        messages: existing
          ? { ...state.messages, [channelId]: existing.map((m) => (m.id === message.id ? message : m)) }
          : state.messages,
      };
    });
  },

  deleteMessage: (channelId: string, messageId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      return {
        journal: recordDelete(state.journal, messageId, protectFloorOf(state.activeFetchVers)),
        messages: existing
          ? { ...state.messages, [channelId]: existing.filter((m) => m.id !== messageId) }
          : state.messages,
      };
    });
  },

  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      const loaded = existing?.find((m) => m.id === messageId);
      const journal = recordReaction(
        state.journal,
        messageId,
        { emoji, userId, op: 'add' },
        loaded,
        protectFloorOf(state.activeFetchVers)
      );
      if (!existing || !loaded) return { journal };
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
      const loaded = existing?.find((m) => m.id === messageId);
      const journal = recordReaction(
        state.journal,
        messageId,
        { emoji, userId, op: 'remove' },
        loaded,
        protectFloorOf(state.activeFetchVers)
      );
      if (!existing || !loaded) return { journal };
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
      activeFetchVers: [],
      appliedBaseSeq: {},
      windowEpoch: {},
      isLoading: {},
      error: null,
      replyingTo: null,
    });
  },
}));
