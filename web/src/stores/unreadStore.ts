import { create } from 'zustand';
import type { ReadState } from '../types';
import { apiGetReadStates, apiAckChannel } from '../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../api/session';
import { createLineage } from './lineage';

interface UnreadState {
  readStates: Record<string, ReadState>; // channelId -> ReadState
  unreadChannels: Set<string>;
  fetchReadStates: () => Promise<void>;
  ackChannel: (channelId: string, messageId: string) => Promise<void>;
  markUnread: (channelId: string) => void;
  incrementMention: (channelId: string) => void;
  isUnread: (channelId: string) => boolean;
  getMentionCount: (channelId: string) => number;
  reset: () => void;
}

// Reconciling lineage for read states (see lineage.ts), keyed by channelId: the
// same fetch/write composition rules as the server and DM lists. A held
// fetchReadStates snapshot must not erase an ack the user just made or a mention
// badge a realtime event just raised -- overlapping writes are journaled and
// re-applied onto the snapshot at commit.
//
// Mention counting is CONVERGENT, not additive. A mention's journaled apply is
// max(snapshot count, local count at claim time): a snapshot that already
// includes the mention carries the same count the client computed, so max
// deduplicates it; a snapshot that predates it carries one less, so max
// preserves the badge. This works because a single socket delivers mention
// events in the server's counting order. Residual (documented, not fixable
// client-side without per-message ids in read-state payloads): a mention
// counted by a snapshot whose own event is delivered only after that snapshot
// commits can transiently over-count until the next ack or fetch.
//
// Acks are RELATIVE to their entry point, not absolute zero: mentions that
// arrive while an ack is in flight were counted by the server AFTER it
// processed the ack, so a late ack response commits "mentions since entry" and
// clears the unread flag only if no new activity arrived during the flight.
const readStateLineage = createLineage<ReadState>((rs) => rs.channelId);

// Per-channel activity epochs, bumped by every locally-observed unread signal.
// An ack captures the epoch at entry; a response settling after newer activity
// must not erase that activity's badge.
const activityEpochs = new Map<string, number>();
const bumpActivity = (channelId: string) =>
  activityEpochs.set(channelId, (activityEpochs.get(channelId) ?? 0) + 1);
// Mention EVENTS only (a subset of activity): the residual count a late ack
// commits is the number of mention events observed during its flight -- a
// count DELTA would be inflated by a mid-flight authoritative fetch carrying
// cross-device mentions the ack actually covered (false badge right after
// reading). Cross-device mentions newer than the ack point surface at the next
// fetch instead; the ack endpoint returning the post-ack read state would make
// this exact (server-side follow-up).
const mentionEpochs = new Map<string, number>();

const toMap = (list: ReadState[]) => {
  const map: Record<string, ReadState> = {};
  list.forEach((rs) => {
    map[rs.channelId] = rs;
  });
  return map;
};
const upsertReadState = (rs: ReadState) => (list: ReadState[]) => [
  rs,
  ...list.filter((r) => r.channelId !== rs.channelId),
];

export const useUnreadStore = create<UnreadState>((set, get) => ({
  readStates: {},
  unreadChannels: new Set(),

  fetchReadStates: async () => {
    const generation = captureSessionGeneration();
    let token = readStateLineage.startFetch();
    try {
      for (;;) {
        const rawStates = await apiGetReadStates();
        if (!isSessionGenerationCurrent(generation)) return;
        const snapshot = Array.isArray(rawStates) ? rawStates : [];
        const outcome = readStateLineage.reconcile(token, snapshot);
        if (outcome.kind === 'superseded') return;
        if (outcome.kind === 'gap') {
          token = readStateLineage.startFetch(); // retry with a fresh snapshot
          continue;
        }
        set({ readStates: toMap(outcome.list) });
        return;
      }
    } catch {
      // Silent fail (no loading flag exists on this resource; there is nothing
      // for a failure to settle or overwrite)
    }
  },

  ackChannel: async (channelId: string, messageId: string) => {
    const generation = captureSessionGeneration();
    const epochAtEntry = activityEpochs.get(channelId) ?? 0;
    const mentionsAtEntry = mentionEpochs.get(channelId) ?? 0;
    try {
      await apiAckChannel(channelId, messageId);
      if (!isSessionGenerationCurrent(generation)) return;
      // Mention EVENTS that arrived after this ack was initiated were counted by
      // the server AFTER it processed the ack -- the committed state is "mention
      // events since entry", never an unconditional zero that would erase them.
      const mentionsSince = (mentionEpochs.get(channelId) ?? 0) - mentionsAtEntry;
      const rs: ReadState = {
        userId: '',
        channelId,
        lastMessageId: messageId,
        lastReadAt: new Date().toISOString(),
        mentionCount: mentionsSince,
      };
      const apply = upsertReadState(rs);
      readStateLineage.claim(apply); // journaled: an older snapshot cannot revert the ack
      set((state) => {
        const newUnread = new Set(state.unreadChannels);
        // Clear the unread flag only if nothing new arrived during the flight.
        if ((activityEpochs.get(channelId) ?? 0) === epochAtEntry) {
          newUnread.delete(channelId);
        }
        return {
          unreadChannels: newUnread,
          readStates: toMap(apply(Object.values(state.readStates))),
        };
      });
    } catch {
      // Silent fail
    }
  },

  // unreadChannels is a purely local set that fetchReadStates never writes, so
  // markUnread needs no lineage claim -- there is no snapshot to race.
  markUnread: (channelId: string) => {
    bumpActivity(channelId);
    set((state) => {
      const newUnread = new Set(state.unreadChannels);
      newUnread.add(channelId);
      return { unreadChannels: newUnread };
    });
  },

  incrementMention: (channelId: string) => {
    bumpActivity(channelId);
    mentionEpochs.set(channelId, (mentionEpochs.get(channelId) ?? 0) + 1);
    // CONVERGENT apply (see module comment): the claim captures the count the
    // client computed for this mention; replay takes max(snapshot, captured), so
    // a snapshot that already includes the mention is not double-counted and one
    // that predates it still gains the badge.
    const countAtClaim = (get().readStates[channelId]?.mentionCount || 0) + 1;
    const apply = (list: ReadState[]) => {
      const existing = list.find((r) => r.channelId === channelId);
      const next: ReadState = {
        ...existing,
        userId: existing?.userId || '',
        channelId,
        lastMessageId: existing?.lastMessageId,
        lastReadAt: existing?.lastReadAt || new Date().toISOString(),
        mentionCount: Math.max(existing?.mentionCount || 0, countAtClaim),
      };
      return [next, ...list.filter((r) => r.channelId !== channelId)];
    };
    readStateLineage.claim(apply); // journaled: a held snapshot cannot eat the badge
    set((state) => ({ readStates: toMap(apply(Object.values(state.readStates))) }));
  },

  isUnread: (channelId: string) => {
    return get().unreadChannels.has(channelId);
  },

  getMentionCount: (channelId: string) => {
    return get().readStates[channelId]?.mentionCount || 0;
  },

  reset: () => {
    readStateLineage.reset(); // held fetches must not repopulate; no cross-account leakage
    activityEpochs.clear();
    mentionEpochs.clear();
    set({ readStates: {}, unreadChannels: new Set() });
  },
}));
