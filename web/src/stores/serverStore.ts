import { create } from 'zustand';
import type { Server, Channel } from '../types';
import {
  apiGetServers,
  apiCreateServer,
  apiGetChannels,
  apiCreateChannel,
} from '../api/client';

interface ServerState {
  servers: Server[];
  selectedServerId: string | null;
  channels: Channel[];
  selectedChannelId: string | null;
  isLoadingServers: boolean;
  isLoadingChannels: boolean;
  error: string | null;
  fetchServers: () => Promise<void>;
  selectServer: (id: string) => Promise<void>;
  selectChannel: (id: string) => void;
  createServer: (name: string) => Promise<void>;
  createChannel: (serverId: string, name: string, topic?: string) => Promise<void>;
  addChannel: (channel: Channel) => void;
  reset: () => void;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  selectedServerId: null,
  channels: [],
  selectedChannelId: null,
  isLoadingServers: false,
  isLoadingChannels: false,
  error: null,

  fetchServers: async () => {
    set({ isLoadingServers: true, error: null });
    try {
      const servers = await apiGetServers();
      set({ servers, isLoadingServers: false });

      // If no server is selected and we have servers, select the first one
      if (!get().selectedServerId && servers.length > 0) {
        await get().selectServer(servers[0].id);
      }
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load servers.');
      set({ isLoadingServers: false, error: message });
    }
  },

  selectServer: async (id: string) => {
    set({
      selectedServerId: id,
      selectedChannelId: null,
      channels: [],
      isLoadingChannels: true,
      error: null,
    });
    try {
      const channels = await apiGetChannels(id);
      const sorted = channels.sort((a, b) => a.position - b.position);
      set({
        channels: sorted,
        isLoadingChannels: false,
      });

      // Auto-select first channel
      if (sorted.length > 0) {
        set({ selectedChannelId: sorted[0].id });
      }
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load channels.');
      set({ isLoadingChannels: false, error: message });
    }
  },

  selectChannel: (id: string) => {
    set({ selectedChannelId: id });
  },

  createServer: async (name: string) => {
    try {
      const server = await apiCreateServer(name);
      set((state) => ({
        servers: [...state.servers, server],
      }));
      // Select the newly created server
      await get().selectServer(server.id);
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to create server.');
      set({ error: message });
      throw new Error(message);
    }
  },

  createChannel: async (serverId: string, name: string, topic?: string) => {
    try {
      const channel = await apiCreateChannel(serverId, name, topic);
      set((state) => ({
        channels: [...state.channels, channel].sort(
          (a, b) => a.position - b.position
        ),
      }));
      // Select the newly created channel
      set({ selectedChannelId: channel.id });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to create channel.');
      set({ error: message });
      throw new Error(message);
    }
  },

  addChannel: (channel: Channel) => {
    set((state) => {
      if (state.selectedServerId === channel.serverId) {
        const exists = state.channels.some((c) => c.id === channel.id);
        if (!exists) {
          return {
            channels: [...state.channels, channel].sort(
              (a, b) => a.position - b.position
            ),
          };
        }
      }
      return {};
    });
  },

  reset: () => {
    set({
      servers: [],
      selectedServerId: null,
      channels: [],
      selectedChannelId: null,
      isLoadingServers: false,
      isLoadingChannels: false,
      error: null,
    });
  },
}));

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const axiosErr = err as {
      response?: { data?: { message?: string; error?: string } };
    };
    if (axiosErr.response?.data?.message) {
      return axiosErr.response.data.message;
    }
    if (axiosErr.response?.data?.error) {
      return axiosErr.response.data.error;
    }
  }
  return fallback;
}
