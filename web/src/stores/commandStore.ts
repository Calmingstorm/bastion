import { create } from 'zustand';
import type { ApplicationCommand } from '../types';
import { apiGetServerCommands } from '../api/client';

interface CommandState {
  commands: ApplicationCommand[];
  serverId: string | null;
  fetchCommands: (serverId: string) => void;
  clear: () => void;
}

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: [],
  serverId: null,

  fetchCommands: (serverId: string) => {
    if (get().serverId === serverId && get().commands.length > 0) return;
    set({ serverId });
    apiGetServerCommands(serverId)
      .then((commands) => {
        if (get().serverId === serverId) {
          set({ commands });
        }
      })
      .catch(() => {});
  },

  clear: () => set({ commands: [], serverId: null }),
}));
