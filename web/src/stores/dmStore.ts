import { create } from 'zustand';
import type { DMChannel } from '../types';
import { apiGetDMs, apiCreateDM, apiCloseDM } from '../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../api/session';

interface DMState {
  dmChannels: DMChannel[];
  selectedDMId: string | null;
  isLoading: boolean;
  error: string | null;
  fetchDMs: () => Promise<void>;
  createDM: (recipientIds: string[]) => Promise<DMChannel | undefined>;
  closeDM: (channelId: string) => Promise<void>;
  selectDM: (channelId: string | null) => void;
  reset: () => void;
}

export const useDMStore = create<DMState>((set) => ({
  dmChannels: [],
  selectedDMId: null,
  isLoading: false,
  error: null,

  fetchDMs: async () => {
    const generation = captureSessionGeneration();
    set({ isLoading: true, error: null });
    try {
      const channels = await apiGetDMs();
      if (!isSessionGenerationCurrent(generation)) return;
      set({ dmChannels: Array.isArray(channels) ? channels : [], isLoading: false });
    } catch {
      if (!isSessionGenerationCurrent(generation)) return;
      set({ isLoading: false, error: 'Failed to load DMs' });
    }
  },

  createDM: async (recipientIds: string[]) => {
    const generation = captureSessionGeneration();
    const dm = await apiCreateDM(recipientIds);
    // The DM was created for the OLD account; do not surface it in the new session.
    if (!isSessionGenerationCurrent(generation)) return undefined;
    set((state) => {
      const exists = state.dmChannels.some((d) => d.id === dm.id);
      if (!exists) {
        return { dmChannels: [dm, ...state.dmChannels] };
      }
      return {};
    });
    return dm;
  },

  closeDM: async (channelId: string) => {
    const generation = captureSessionGeneration();
    await apiCloseDM(channelId);
    if (!isSessionGenerationCurrent(generation)) return;
    set((state) => ({
      dmChannels: state.dmChannels.filter((d) => d.id !== channelId),
      selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
    }));
  },

  selectDM: (channelId: string | null) => {
    set({ selectedDMId: channelId });
  },

  reset: () => {
    set({
      dmChannels: [],
      selectedDMId: null,
      isLoading: false,
      error: null,
    });
  },
}));
