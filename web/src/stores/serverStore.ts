import { create } from 'zustand';
import type { Server, Channel } from '../types';
import {
  apiGetServers,
  apiCreateServer,
  apiGetChannels,
  apiCreateChannel,
  apiLeaveServer,
  apiDeleteServer,
} from '../api/client';
import {
  captureSessionGeneration,
  isSessionGenerationCurrent,
  SessionSupersededError,
} from '../api/session';
import { extractErrorMessage } from '../utils/errors';
import { usePermissionStore } from './permissionStore';

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
  createChannel: (serverId: string, name: string, topic?: string, categoryId?: string) => Promise<void>;
  updateServer: (server: Server) => void;
  addChannel: (channel: Channel) => void;
  updateChannel: (channel: Channel) => void;
  removeChannel: (channelId: string) => void;
  leaveServer: (serverId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  removeServer: (serverId: string) => void;
  reset: () => void;
}

// One recency lineage for the (selectedServerId, channels) resource: fetchServers'
// auto-select branch and selectServer both write it, so they share the counter --
// whichever starts LAST owns the resource, and an older continuation (e.g.
// selectServer(A) settling after selectServer(B)) commits nothing.
let serverScopeSeq = 0;
export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  selectedServerId: null,
  channels: [],
  selectedChannelId: null,
  isLoadingServers: false,
  isLoadingChannels: false,
  error: null,

  fetchServers: async () => {
    // Capture the session at entry; after every await, bail if an identity
    // boundary has passed so a late response never writes the old account's data.
    // Claim the scope lineage too: this call's channel-writes are superseded by
    // any later selectServer/fetchServers.
    const generation = captureSessionGeneration();
    const seq = ++serverScopeSeq;
    const owns = () => seq === serverScopeSeq && isSessionGenerationCurrent(generation);
    set({ isLoadingServers: true, error: null });
    try {
      const rawServers = await apiGetServers();
      if (!owns()) return;
      const servers = Array.isArray(rawServers) ? rawServers : [];

      // If no server is selected and we have servers, merge server list +
      // initial selection into a single state update to avoid cascading renders.
      if (!get().selectedServerId && servers.length > 0) {
        set({
          servers,
          isLoadingServers: false,
          selectedServerId: servers[0].id,
          selectedChannelId: null,
          channels: [],
          isLoadingChannels: true,
          error: null,
        });

        // Fetch permissions for the auto-selected server
        usePermissionStore.getState().fetchPermissions(servers[0].id);

        // Fetch channels for the auto-selected server
        try {
          const rawChannels = await apiGetChannels(servers[0].id);
          if (!owns()) return;
          const sorted = (Array.isArray(rawChannels) ? rawChannels : []).sort((a, b) => a.position - b.position);
          set({
            channels: sorted,
            isLoadingChannels: false,
            selectedChannelId: sorted.length > 0 ? sorted[0].id : null,
          });
        } catch {
          if (!owns()) return;
          set({ isLoadingChannels: false });
        }
      } else {
        set({ servers, isLoadingServers: false });
      }
    } catch (err: unknown) {
      if (!owns()) return;
      const message = extractErrorMessage(err, 'Failed to load servers.');
      set({ isLoadingServers: false, error: message });
    }
  },

  selectServer: async (id: string) => {
    // Owned by session AND scope recency: concurrent selectServer(A)/selectServer(B)
    // must leave the LAST selection's channels, never B selected with A's channels.
    const generation = captureSessionGeneration();
    const seq = ++serverScopeSeq;
    const owns = () => seq === serverScopeSeq && isSessionGenerationCurrent(generation);
    set({
      selectedServerId: id,
      selectedChannelId: null,
      channels: [],
      isLoadingChannels: true,
      error: null,
    });
    // Fetch permissions for the selected server
    usePermissionStore.getState().fetchPermissions(id);
    try {
      const rawChannels = await apiGetChannels(id);
      if (!owns()) return;
      const sorted = (Array.isArray(rawChannels) ? rawChannels : []).sort((a, b) => a.position - b.position);
      // Merge channels + auto-select into a single state update
      set({
        channels: sorted,
        isLoadingChannels: false,
        selectedChannelId: sorted.length > 0 ? sorted[0].id : null,
      });
    } catch (err: unknown) {
      if (!owns()) return;
      const message = extractErrorMessage(err, 'Failed to load channels.');
      set({ isLoadingChannels: false, error: message });
    }
  },

  selectChannel: (id: string) => {
    set({ selectedChannelId: id });
  },

  // Superseded mutations REJECT (SessionSupersededError) rather than fulfilling: a
  // caller cannot tell a silent stale return from success and would run its success
  // UI for an operation that belongs to a previous account. Callers swallow the
  // typed error -- it is neither a success nor an error of the current session.
  createServer: async (name: string) => {
    const generation = captureSessionGeneration();
    try {
      const server = await apiCreateServer(name);
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      set((state) => ({
        servers: [...state.servers, server],
      }));
      // Select the newly created server (itself session-guarded)
      await get().selectServer(server.id);
      // selectServer never rejects, so a boundary during ITS await would otherwise
      // let this mutation fulfill -- the contract covers every await, not just the
      // first one.
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
    } catch (err: unknown) {
      if (err instanceof SessionSupersededError) throw err;
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      const message = extractErrorMessage(err, 'Failed to create server.');
      set({ error: message });
      throw new Error(message);
    }
  },

  createChannel: async (serverId: string, name: string, topic?: string, categoryId?: string) => {
    const generation = captureSessionGeneration();
    try {
      const channel = await apiCreateChannel(serverId, name, topic, categoryId);
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      // Scope check: the channel was created on `serverId`. If the user has since
      // switched servers, the create SUCCEEDED (resolve normally) but it must not
      // be appended to -- or selected within -- the new server's state.
      if (get().selectedServerId !== serverId) return;
      set((state) => ({
        channels: [...state.channels, channel].sort(
          (a, b) => a.position - b.position
        ),
      }));
      // Select the newly created channel
      set({ selectedChannelId: channel.id });
    } catch (err: unknown) {
      if (err instanceof SessionSupersededError) throw err;
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      const message = extractErrorMessage(err, 'Failed to create channel.');
      set({ error: message });
      throw new Error(message);
    }
  },

  updateServer: (server: Server) => {
    set((state) => ({
      servers: state.servers.map((s) => (s.id === server.id ? { ...s, ...server } : s)),
    }));
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

  updateChannel: (channel: Channel) => {
    set((state) => ({
      channels: state.channels.map((c) =>
        c.id === channel.id ? { ...c, ...channel } : c
      ),
    }));
  },

  removeChannel: (channelId: string) => {
    set((state) => {
      const remaining = state.channels.filter((c) => c.id !== channelId);
      const updates: Partial<ServerState> = { channels: remaining };
      // Auto-select next channel if the deleted one was selected
      if (state.selectedChannelId === channelId) {
        updates.selectedChannelId = remaining.length > 0 ? remaining[0].id : null;
      }
      return updates;
    });
  },

  leaveServer: async (serverId: string) => {
    const generation = captureSessionGeneration();
    try {
      await apiLeaveServer(serverId);
    } catch (err: unknown) {
      // The failure arm honors the same contract: a stale rejection is the
      // superseded outcome, not an error of the current session's concern.
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      throw err;
    }
    if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
    get().removeServer(serverId);
  },

  deleteServer: async (serverId: string) => {
    const generation = captureSessionGeneration();
    try {
      await apiDeleteServer(serverId);
    } catch (err: unknown) {
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      throw err;
    }
    if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
    get().removeServer(serverId);
  },

  removeServer: (serverId: string) => {
    set((state) => {
      const remaining = state.servers.filter((s) => s.id !== serverId);
      if (state.selectedServerId === serverId) {
        return {
          servers: remaining,
          selectedServerId: remaining[0]?.id || null,
          channels: [],
          selectedChannelId: null,
        };
      }
      return { servers: remaining };
    });
    // If we just cleared selection, auto-select first available server
    const { selectedServerId, servers } = get();
    if (selectedServerId && servers.length > 0) {
      get().selectServer(selectedServerId);
    }
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

