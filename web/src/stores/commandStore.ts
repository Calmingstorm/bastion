import { create } from 'zustand';
import type { ApplicationCommand } from '../types';
import { apiGetServerCommands } from '../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../api/session';

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
    const generation = captureSessionGeneration();
    set({ serverId });
    apiGetServerCommands(serverId)
      .then((commands) => {
        // The serverId match is not enough -- two accounts can share a server id.
        // Only apply if the session that started the fetch is still current.
        if (isSessionGenerationCurrent(generation) && get().serverId === serverId) {
          set({ commands });
        }
      })
      .catch(() => {});
  },

  clear: () => set({ commands: [], serverId: null }),
}));
