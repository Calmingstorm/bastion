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
  markUnread: (channelId: string, mark?: { seq?: number; at?: string }) => void;
  incrementMention: (channelId: string) => void;
  isUnread: (channelId: string) => boolean;
  getMentionCount: (channelId: string) => number;
  reset: () => void;
}

// Mention counts are SERVER-OWNED. The client never infers a committed count
// from event arrival order -- server commit order and client arrival order are
// different clocks, and every arithmetic bridge between them (additive bumps,
// convergent max, entry-relative deltas) had a losing interleaving. Instead:
//
//   - A local write (mention event, ack response) applies an OPTIMISTIC direct
//     update for instant UI, then TRIGGERS an authoritative fetch. The trigger
//     claims the lineage, so every older in-flight snapshot is superseded, and
//     the triggered snapshot is server truth minted after the write reached the
//     server (a mention is committed before it is broadcast; an ack is
//     committed before its response returns).
//   - Nothing journals claims on this lineage: with every write followed by an
//     owned fetch, supersession alone orders the world. The committed count is
//     always a server-produced number, never a client-computed one.
//
// The unread FLAG (unreadChannels) stays local -- fetches never write it; an
// ack clears it only when no newer activity arrived during its flight.
const readStateLineage = createLineage<ReadState>((rs) => rs.channelId);

// Per-channel activity epochs, bumped by every locally-observed unread signal.
// An ack captures the epoch at entry; a response settling after newer activity
// must not clear the flag that activity raised.
const activityEpochs = new Map<string, number>();
const bumpActivity = (channelId: string) =>
  activityEpochs.set(channelId, (activityEpochs.get(channelId) ?? 0) + 1);

// Bumped by reset(): an ack held across a store reset must not repopulate the
// cleared store or fire its follow-up fetch (auth generation aside).
let resetEpoch = 0;

// The unread FLAG must also reconcile with server truth: a DELAYED pre-ack
// notification (its message was already covered by an ack) would otherwise
// resurrect the flag forever, since fetches never write the flag and only an
// ack clears it.
//
// The PRIMARY watermark is the message's server-owned seq compared against the
// read state's lastReadSeq: one database-assigned total order tied to both the
// write and the acknowledgment -- no wall clock, nothing a bot can supply, and
// immune to late delivery (a pre-ack message broadcast late still carries its
// pre-ack seq). The TIME tier survives only as a fallback for events from
// servers that predate the seq migration.
// flagRaised records the newest watermark that raised each flag on both axes;
// a committed read state covering either axis clears the flag.
const flagRaised = new Map<string, { seq: number | null; at: number | null }>();

const toMap = (list: ReadState[]) => {
  const map: Record<string, ReadState> = {};
  list.forEach((rs) => {
    map[rs.channelId] = rs;
  });
  return map;
};

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
        // Reconcile the unread FLAG with the committed truth: a committed read
        // watermark at or beyond what raised the flag means the user has read
        // it (possibly from another device, possibly an ack this flag's delayed
        // notification predated). The seq axis decides when both sides have it;
        // the time axis only covers fallback-tier raises.
        set((state) => {
          const newUnread = new Set(state.unreadChannels);
          for (const rs of outcome.list) {
            const raised = flagRaised.get(rs.channelId);
            if (!raised) continue;
            const seqCovered =
              raised.seq != null && rs.lastReadSeq !== undefined && rs.lastReadSeq >= raised.seq;
            const atCovered =
              raised.seq == null &&
              raised.at != null &&
              !!rs.lastReadAt &&
              Date.parse(rs.lastReadAt) >= raised.at;
            if (seqCovered || atCovered) {
              newUnread.delete(rs.channelId);
              flagRaised.delete(rs.channelId);
            }
          }
          return { readStates: toMap(outcome.list), unreadChannels: newUnread };
        });
        return;
      }
    } catch {
      // Silent fail (no loading flag exists on this resource; there is nothing
      // for a failure to settle or overwrite)
    }
  },

  ackChannel: async (channelId: string, messageId: string) => {
    // DEDUPE: scroll handlers re-ack the newest message on every scroll event;
    // re-acking the exact message already recorded -- with nothing new having
    // arrived -- is a no-op server-side (the watermark gate) and must not fire
    // another POST + follow-up fetch per wheel tick.
    const known = get().readStates[channelId];
    if (
      known?.lastMessageId === messageId &&
      !get().unreadChannels.has(channelId) &&
      (known?.mentionCount || 0) === 0
    ) {
      return;
    }
    const generation = captureSessionGeneration();
    const epochAtReset = resetEpoch;
    const epochAtEntry = activityEpochs.get(channelId) ?? 0;
    const countAtEntry = get().readStates[channelId]?.mentionCount || 0;
    try {
      await apiAckChannel(channelId, messageId);
      if (!isSessionGenerationCurrent(generation)) return;
      if (epochAtReset !== resetEpoch) return; // reset() intervened: nothing to write
      set((state) => {
        const newUnread = new Set(state.unreadChannels);
        // Clear the unread flag only if nothing new arrived during the flight.
        if ((activityEpochs.get(channelId) ?? 0) === epochAtEntry) {
          newUnread.delete(channelId);
          flagRaised.delete(channelId);
        }
        // OPTIMISTIC zero, gated on nothing having moved since entry (no new
        // activity, no authoritative rebase): if anything moved, leave the count
        // alone -- the follow-up fetch settles it with server truth either way.
        const untouched =
          (activityEpochs.get(channelId) ?? 0) === epochAtEntry &&
          (state.readStates[channelId]?.mentionCount || 0) === countAtEntry;
        if (!untouched) return { unreadChannels: newUnread };
        return {
          unreadChannels: newUnread,
          readStates: {
            ...state.readStates,
            [channelId]: {
              userId: '',
              channelId,
              lastMessageId: messageId,
              // Keep the previous SERVER-minted lastReadAt rather than fabricate
              // one from the client clock -- markUnread compares message
              // createdAt against this field, and mixing clocks would corrupt
              // that comparison. The follow-up fetch supplies the fresh value.
              lastReadAt: state.readStates[channelId]?.lastReadAt ?? '',
              // PRESERVE the known read watermark: dropping it would let a
              // delayed event already covered by it re-flag the channel while
              // the follow-up fetch is pending -- or forever, if that fetch
              // fails. The follow-up advances it.
              lastReadSeq: state.readStates[channelId]?.lastReadSeq,
              mentionCount: 0,
            },
          },
        };
      });
      // AUTHORITATIVE follow-up: the server committed this ack before replying,
      // so a fetch started now returns the post-ack truth (including mentions
      // the ack did NOT cover) and supersedes every older in-flight snapshot.
      void get().fetchReadStates();
    } catch {
      // Silent fail
    }
  },

  // markUnread needs no follow-up fetch (there is no server count to sync), but
  // it is watermark-aware: a message already covered by the read watermark is
  // not unread (its notification was delayed past the ack that read it), and
  // the raise is recorded so a LATER committed watermark can retire the flag.
  markUnread: (channelId: string, mark?: { seq?: number; at?: string }) => {
    const rs = get().readStates[channelId];
    const seq = mark?.seq;
    // COVERED events are complete no-ops -- the activity epoch must not move
    // either: it answers "did anything the user has NOT read arrive during the
    // ack's flight", and a delayed already-read event would otherwise suppress
    // that ack's flag-clear (stranding a flag that has no watermark to retire
    // it).
    if (seq !== undefined) {
      // Primary tier: the server-owned sequence.
      if (rs?.lastReadSeq !== undefined && seq <= rs.lastReadSeq) return;
      bumpActivity(channelId);
      const prev = flagRaised.get(channelId);
      flagRaised.set(channelId, {
        seq: prev?.seq == null ? seq : Math.max(prev.seq, seq),
        at: prev?.at ?? null,
      });
    } else {
      // Fallback tier (pre-seq servers): server-minted times on one clock.
      const raisedAt = mark?.at ? Date.parse(mark.at) : NaN;
      if (!Number.isNaN(raisedAt)) {
        if (rs?.lastReadAt && Date.parse(rs.lastReadAt) >= raisedAt) return; // already read
        bumpActivity(channelId);
        const prev = flagRaised.get(channelId);
        flagRaised.set(channelId, {
          seq: prev?.seq ?? null,
          at: prev?.at == null ? raisedAt : Math.max(prev.at, raisedAt),
        });
      } else {
        bumpActivity(channelId); // no watermark at all: conservatively activity
      }
    }
    set((state) => {
      const newUnread = new Set(state.unreadChannels);
      newUnread.add(channelId);
      return { unreadChannels: newUnread };
    });
  },

  incrementMention: (channelId: string) => {
    bumpActivity(channelId);
    // OPTIMISTIC bump for instant UI only -- the committed count comes from the
    // follow-up fetch (the server counted this mention before broadcasting it,
    // so the triggered snapshot includes it; it also corrects the bump if an
    // authoritative snapshot had ALREADY counted this mention).
    set((state) => {
      const existing = state.readStates[channelId];
      return {
        readStates: {
          ...state.readStates,
          [channelId]: {
            ...existing,
            userId: existing?.userId || '',
            channelId,
            lastMessageId: existing?.lastMessageId,
            // NEVER fabricate a read time from the client clock: the fallback
            // watermark compares this field against server-minted message
            // times, and a fabricated value ahead of the server would swallow
            // genuinely new messages as "already read". '' means no watermark.
            lastReadAt: existing?.lastReadAt || '',
            mentionCount: (existing?.mentionCount || 0) + 1,
          },
        },
      };
    });
    void get().fetchReadStates();
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
    flagRaised.clear();
    resetEpoch += 1;
    set({ readStates: {}, unreadChannels: new Set() });
  },
}));
