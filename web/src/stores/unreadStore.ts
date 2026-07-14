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
  markUnread: (channelId: string, mark?: { seq?: number; at?: string }) => boolean;
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
//   - The ack RETURNS the committed read state (watermark + server-computed
//     mention count). On a quiet flight the client commits that authoritative
//     state and CLAIMS the lineage, so a held pre-ack fetch reconciles it IN
//     (seq-ordered) instead of clobbering it -- the claim is load-bearing. On a
//     flight during which new activity arrived, the response is stale, so the
//     client commits nothing and settles via a fresh fetch.
//   - A mention event applies an OPTIMISTIC +1 for instant UI, then triggers an
//     authoritative fetch that supersedes older snapshots and carries the true
//     server count.
//   - Every committed count is a server-produced number, never client-computed.
//
// The unread FLAG (unreadChannels) is reconciled by the fetch: a channel stays
// flagged while it has unread mentions (committed count > 0) OR a local raise
// not yet covered by the watermark; otherwise the fetch clears it.
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
            if (!newUnread.has(rs.channelId)) continue;
            const raised = flagRaised.get(rs.channelId);
            const seqCovered =
              !!raised && raised.seq != null && rs.lastReadSeq !== undefined && rs.lastReadSeq >= raised.seq;
            const atCovered =
              !!raised &&
              raised.seq == null &&
              raised.at != null &&
              !!rs.lastReadAt &&
              Date.parse(rs.lastReadAt) >= raised.at;
            // A flag with NO local raise (e.g. raised by an ack's nonzero
            // committed count) counts as covered -- only the server mention
            // count keeps it up. Clear the flag only when the local raise is
            // covered AND the server shows no unread mentions here.
            const raiseCovered = !raised || seqCovered || atCovered;
            if (raiseCovered && rs.mentionCount === 0) {
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
    try {
      // The ack returns the COMMITTED read state -- the true watermark and the
      // server-computed mention count. The client commits THAT, never an
      // optimistic guess: no pending/failed follow-up fetch can leave the badge
      // wrong, and a stale/duplicate ack returns the (possibly newer) truth
      // already on disk rather than erasing a mention it did not cover.
      const committed = await apiAckChannel(channelId, messageId);
      if (!isSessionGenerationCurrent(generation)) return;
      if (epochAtReset !== resetEpoch) return; // reset() intervened: nothing to write
      // If new activity arrived DURING the flight, the committed response
      // predates it (its watermark/count reflect server state at ack-commit
      // time, before that activity): it is stale. Do NOT commit or claim it.
      // A mention-event during the flight settles itself via its own triggered
      // fetch, but a plain markUnread (a non-mention message) triggers nothing,
      // so settle the channel authoritatively here rather than leave the count
      // stale forever (the pre-response state is otherwise never reconciled).
      if ((activityEpochs.get(channelId) ?? 0) !== epochAtEntry) {
        void get().fetchReadStates();
        return;
      }
      // Quiet flight: the response is current server truth. Claim it so a held
      // pre-ack fetch reconciles it IN rather than clobbering it with a pre-ack
      // snapshot, then commit. The apply is MONOTONIC on the watermark: two acks
      // can complete out of order (device acks m5 then m9; the m5 response, which
      // the server no-op'd, may carry an OLDER committed watermark and arrive
      // last), so it never regresses lastReadSeq -- the higher watermark, and its
      // authoritative count, win regardless of completion order.
      const apply = (list: ReadState[]) => {
        const existing = list.find((r) => r.channelId === channelId);
        // Watermark alone cannot order equal-watermark projections: a mention may
        // commit above that watermark between two server reads, and either response
        // can settle last. projectionRevision is advanced under the read_states row
        // lock by both acks and mentions, so it is the authoritative tie-breaker.
        // The watermark fallback keeps compatibility with pre-revision servers.
        const existingRevision = existing?.projectionRevision;
        const committedRevision = committed.projectionRevision;
        const existingWins =
          !!existing &&
          (existingRevision !== undefined && committedRevision !== undefined
            ? existingRevision >= committedRevision
            : (existing.lastReadSeq ?? -1) >= (committed.lastReadSeq ?? -1));
        const winner = existingWins ? existing : committed;
        return [winner, ...list.filter((r) => r.channelId !== channelId)];
      };
      readStateLineage.claim(apply);
      set((state) => {
        const newUnread = new Set(state.unreadChannels);
        const nextStates = toMap(apply(Object.values(state.readStates)));
        // Base the flag on the WINNING (highest-watermark) read state, not the
        // possibly-stale response -- if a newer ack already won, its count rules.
        const winning = nextStates[channelId];
        if ((winning?.mentionCount ?? 0) === 0) {
          newUnread.delete(channelId);
          flagRaised.delete(channelId);
        } else {
          // Cross-device mentions above the committed watermark keep the channel
          // flagged; the fetch reconciliation retires it once the server shows
          // no unread mentions here (they were read elsewhere).
          newUnread.add(channelId);
        }
        return { unreadChannels: newUnread, readStates: nextStates };
      });
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
    if (seq !== undefined && seq > 0) {
      // Primary tier: the server-owned sequence (seq starts at 1; a 0/negative
      // seq from a nonconforming server would falsely test as covered against
      // any watermark, so it never enters this tier).
      if (rs?.lastReadSeq !== undefined) {
        if (seq <= rs.lastReadSeq) return false; // covered by the seq watermark
      } else if (rs?.lastReadAt && mark?.at && Date.parse(rs.lastReadAt) >= Date.parse(mark.at)) {
        // No seq watermark yet (e.g. a read state migrated before seq existed),
        // but a server-minted read time covers this event: still covered.
        return false;
      }
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
        if (rs?.lastReadAt && Date.parse(rs.lastReadAt) >= raisedAt) return false; // already read
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
    return true;
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
