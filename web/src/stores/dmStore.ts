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
const upsertDM = (dm: DMChannel) => (list: DMChannel[]) => {
  const existing = list.find((d) => d.id === dm.id);
  const merged = existing ? { ...existing, ...dm } : dm;
  return [merged, ...list.filter((d) => d.id !== dm.id)];
};

export const useDMStore = create<DMState>((set) => ({
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
        set({ dmChannels: outcome.list, isLoading: false });
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
    const apply = upsertDM(dm);
    dmLineage.claim(apply, { asserts: [dm.id] });
    set((state) => ({ dmChannels: apply(state.dmChannels) }));
    return dm;
  },

  closeDM: async (channelId: string) => {
    const generation = captureSessionGeneration();
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
    // UPSERT unconditionally (merge semantics -- see upsertDM): fields the fresh
    // payload carries replace the stale object's, fields it is silent on survive;
    // the journaled application reconciles onto any overlapping fetch.
    const apply = upsertDM(dm);
    dmLineage.claim(apply, { asserts: [dm.id] });
    set((state) => ({ dmChannels: apply(state.dmChannels) }));
  },

  selectDM: (channelId: string | null) => {
    set({ selectedDMId: channelId });
  },

  reset: () => {
    // Full lineage reset, not just a barrier: held fetches are superseded AND
    // accumulated tombstones are dropped -- account A closing a shared DM must
    // not hide that same conversation from account B on this client.
    dmLineage.reset();
    set({
      dmChannels: [],
      selectedDMId: null,
      isLoading: false,
      error: null,
    });
  },
}));
