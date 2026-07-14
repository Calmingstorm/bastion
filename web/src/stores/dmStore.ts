import { create } from 'zustand';
import type { DMChannel } from '../types';
import { apiGetDMs, apiCreateDM, apiCloseDM } from '../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../api/session';
import { useToastStore } from './toastStore';
import { createLineage } from './lineage';

interface DMState {
  dmChannels: DMChannel[];
  selectedDMId: string | null;
  isLoading: boolean;
  error: string | null;
  fetchDMs: () => Promise<void>;
  createDM: (recipientIds: string[]) => Promise<DMChannel | undefined>;
  addDM: (dm: DMChannel) => void;
  closeDM: (channelId: string) => Promise<void>;
  noteChannelAlive: (channelId: string) => void;
  selectDM: (channelId: string | null) => void;
  reset: () => void;
}

// Reconciling lineage for the DM list (see lineage.ts): mutations journal their
// functional application, so an overlapping fetch commits its snapshot WITH them
// re-applied -- never discarding unaffected rows.
const dmLineage = createLineage<DMChannel>((d) => d.id);
// Upserts MERGE rather than replace: a whole-object DM_CREATE (or its journal
// entry replayed onto a fresher snapshot row) may be SILENT on enriched fields
// like the lastMessage preview -- receipt order is not data freshness. Fields
// the payload carries win; fields it is silent on survive.
// Per-channel proof-of-life epochs: bumped whenever the server demonstrates a
// DM is alive (a message arrives in it, a DM_CREATE lands, a create/reopen
// response returns). A close captures the epoch at entry; a response settling
// AFTER newer proof of life is superseded -- the server reopened the DM after
// processing the close, and installing a fresh tombstone would filter the very
// snapshot that truthfully shows it open.
const aliveEpochs = new Map<string, number>();
const bumpAlive = (channelId: string) =>
  aliveEpochs.set(channelId, (aliveEpochs.get(channelId) ?? 0) + 1);

const upsertDM = (dm: DMChannel) => (list: DMChannel[]) => {
  const existing = list.find((d) => d.id === dm.id);
  const merged = existing ? { ...existing, ...dm } : dm;
  return [merged, ...list.filter((d) => d.id !== dm.id)];
};

export const useDMStore = create<DMState>((set, get) => ({
  dmChannels: [],
  selectedDMId: null,
  isLoading: false,
  error: null,

  fetchDMs: async () => {
    const generation = captureSessionGeneration();
    let token = dmLineage.startFetch();
    set({ isLoading: true, error: null });
    try {
      for (;;) {
        const channels = await apiGetDMs();
        if (!isSessionGenerationCurrent(generation)) return;
        const outcome = dmLineage.reconcile(token, Array.isArray(channels) ? channels : []);
        if (outcome.kind === 'superseded') return;
        if (outcome.kind === 'gap') {
          // The journal outran this fetch; RETRY for a fresh snapshot rather
          // than keep partial state (a newer fetch/barrier exits via superseded).
          token = dmLineage.startFetch();
          continue;
        }
        // The SELECTION is reconciled with the committed list (same rule as the
        // server selection): if the authoritative list omits the selected DM --
        // e.g. a close won its race and the deciding fetch drops the row -- the
        // selection must not dangle over a conversation that no longer exists.
        set((state) => ({
          dmChannels: outcome.list,
          isLoading: false,
          selectedDMId:
            state.selectedDMId && outcome.list.some((d) => d.id === state.selectedDMId)
              ? state.selectedDMId
              : null,
        }));
        return;
      }
    } catch {
      if (!isSessionGenerationCurrent(generation)) return;
      // Failure commits are ownership-checked too: an older fetch's rejection
      // must not overwrite a newer fetch's state or spinner.
      if (!dmLineage.owns(token)) return;
      set({ isLoading: false, error: 'Failed to load DMs' });
    }
  },

  createDM: async (recipientIds: string[]) => {
    const generation = captureSessionGeneration();
    const dm = await apiCreateDM(recipientIds);
    // The DM was created for the OLD account; do not surface it in the new session.
    if (!isSessionGenerationCurrent(generation)) return undefined;
    // Journal an UPSERT unconditionally: a successful create (even a same-ID
    // reopen) is newer truth; an overlapping fetch reconciles it onto its snapshot.
    bumpAlive(dm.id);
    const apply = upsertDM(dm);
    dmLineage.claim(apply, { asserts: [dm.id] });
    set((state) => ({ dmChannels: apply(state.dmChannels) }));
    return dm;
  },

  closeDM: async (channelId: string) => {
    const generation = captureSessionGeneration();
    const epochAtEntry = aliveEpochs.get(channelId) ?? 0;
    try {
      await apiCloseDM(channelId);
    } catch {
      // Every caller is fire-and-forget, so this action must be TOTAL -- it never
      // rejects. Logout aborts the in-flight request (a rejection that would
      // otherwise surface as an unhandled rejection mid-teardown); swallow it when
      // the session has ended, and surface a same-session failure as a toast (the
      // app-level ToastContainer renders it -- nothing renders dmStore.error).
      if (!isSessionGenerationCurrent(generation)) return;
      useToastStore.getState().addToast('Failed to close conversation');
      return;
    }
    // Deliberately a silent return (not a SessionSupersededError like the server
    // mutations): fire-and-forget callers have no success UI to mislead.
    if (!isSessionGenerationCurrent(generation)) return;
    // Proof of life arrived during the flight. WHICH mutation won -- the close
    // or the reopen -- is the server's knowledge; client arrival order cannot
    // decide it. So neither guess: skip the local removal AND the tombstone,
    // and ask -- the authoritative list either contains the id (reopen won) or
    // omits it (close won, and the row simply drops out; an honest close needs
    // no tombstone).
    if ((aliveEpochs.get(channelId) ?? 0) !== epochAtEntry) {
      void get().fetchDMs();
      return;
    }
    const apply = (list: DMChannel[]) => list.filter((d) => d.id !== channelId);
    // Journaled + tombstoned: an older snapshot -- even one whose fetch starts
    // after this close -- cannot resurrect the closed conversation.
    dmLineage.claim(apply, { removes: [channelId] });
    set((state) => ({
      dmChannels: apply(state.dmChannels),
      selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
    }));
  },

  // Realtime DM_CREATE commits through here: the write claims the list lineage
  // (commit supersession) so an older fetch snapshot settling later cannot erase it.
  addDM: (dm: DMChannel) => {
    bumpAlive(dm.id);
    // UPSERT unconditionally (merge semantics -- see upsertDM): fields the fresh
    // payload carries replace the stale object's, fields it is silent on survive;
    // the journaled application reconciles onto any overlapping fetch.
    const apply = upsertDM(dm);
    dmLineage.claim(apply, { asserts: [dm.id] });
    set((state) => ({ dmChannels: apply(state.dmChannels) }));
  },

  // An event proved this channel is alive -- a message arrived in it (the server
  // reopens a closed DM BEFORE broadcasting MESSAGE_CREATE). Clears any close
  // tombstone so the refetch that same event triggers can SHOW the reopened
  // conversation instead of filtering it.
  //
  // When the DM is locally KNOWN, the aliveness is also made DURABLE: the known
  // row is journaled as an upsert, so an in-flight fetch whose snapshot was read
  // before this reopen (a close/reopen deciding fetch, an initial load) commits
  // WITH the row re-applied instead of erasing an open conversation. It also
  // moves the DM to the front -- a new message makes it the most recent.
  noteChannelAlive: (channelId: string) => {
    bumpAlive(channelId);
    dmLineage.assert([channelId]);
    const known = useDMStore.getState().dmChannels.find((d) => d.id === channelId);
    if (known) {
      const apply = upsertDM(known);
      dmLineage.claim(apply, { asserts: [channelId] });
      set((state) => ({ dmChannels: apply(state.dmChannels) }));
    }
  },

  selectDM: (channelId: string | null) => {
    set({ selectedDMId: channelId });
  },

  reset: () => {
    // Full lineage reset, not just a barrier: held fetches are superseded AND
    // accumulated tombstones are dropped -- account A closing a shared DM must
    // not hide that same conversation from account B on this client.
    dmLineage.reset();
    aliveEpochs.clear();
    set({
      dmChannels: [],
      selectedDMId: null,
      isLoading: false,
      error: null,
    });
  },
}));
