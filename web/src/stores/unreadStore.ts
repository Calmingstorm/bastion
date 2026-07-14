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
// Both writes are journaled deliberately, with different justifications: an ack
// is a server-CONFIRMED mutation (losing it shows a stale badge the user just
// cleared); a mention increment is an optimistic event hint whose replay onto a
// snapshot that already includes the same mention can transiently OVER-count by
// the overlap -- accepted, because for a notification a brief extra badge beats
// a vanished one, and the next fetch commits the authoritative count.
const readStateLineage = createLineage<ReadState>((rs) => rs.channelId);

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
    try {
      await apiAckChannel(channelId, messageId);
      if (!isSessionGenerationCurrent(generation)) return;
      const rs: ReadState = {
        userId: '',
        channelId,
        lastMessageId: messageId,
        lastReadAt: new Date().toISOString(),
        mentionCount: 0,
      };
      const apply = upsertReadState(rs);
      readStateLineage.claim(apply); // journaled: an older snapshot cannot revert the ack
      set((state) => {
        const newUnread = new Set(state.unreadChannels);
        newUnread.delete(channelId);
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
    set((state) => {
      const newUnread = new Set(state.unreadChannels);
      newUnread.add(channelId);
      return { unreadChannels: newUnread };
    });
  },

  incrementMention: (channelId: string) => {
    const apply = (list: ReadState[]) => {
      const existing = list.find((r) => r.channelId === channelId);
      const next: ReadState = {
        ...existing,
        userId: existing?.userId || '',
        channelId,
        lastMessageId: existing?.lastMessageId,
        lastReadAt: existing?.lastReadAt || new Date().toISOString(),
        mentionCount: (existing?.mentionCount || 0) + 1,
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
    set({ readStates: {}, unreadChannels: new Set() });
  },
}));
