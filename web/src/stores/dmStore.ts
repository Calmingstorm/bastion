import { create } from 'zustand';
import type { DMChannel } from '../types';
import { apiGetDMs, apiCreateDM } from '../api/client';

interface DMState {
  dmChannels: DMChannel[];
  selectedDMId: string | null;
  isLoading: boolean;
  error: string | null;
  fetchDMs: () => Promise<void>;
  createDM: (recipientIds: string[]) => Promise<DMChannel>;
  selectDM: (channelId: string | null) => void;
  reset: () => void;
}

export const useDMStore = create<DMState>((set) => ({
  dmChannels: [],
  selectedDMId: null,
  isLoading: false,
  error: null,

  fetchDMs: async () => {
    set({ isLoading: true, error: null });
    try {
      const channels = await apiGetDMs();
      set({ dmChannels: channels, isLoading: false });
    } catch {
      set({ isLoading: false, error: 'Failed to load DMs' });
    }
  },

  createDM: async (recipientIds: string[]) => {
    const dm = await apiCreateDM(recipientIds);
    set((state) => {
      const exists = state.dmChannels.some((d) => d.id === dm.id);
      if (!exists) {
        return { dmChannels: [dm, ...state.dmChannels] };
      }
      return {};
    });
    return dm;
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
