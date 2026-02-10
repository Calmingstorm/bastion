import { create } from 'zustand';

interface PresenceState {
  presences: Record<string, string>; // userId -> status
  setPresence: (userId: string, status: string) => void;
  getPresence: (userId: string) => string;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  presences: {},

  setPresence: (userId: string, status: string) => {
    set((state) => ({
      presences: { ...state.presences, [userId]: status },
    }));
  },

  getPresence: (userId: string) => {
    return get().presences[userId] || 'offline';
  },

  reset: () => {
    set({ presences: {} });
  },
}));
