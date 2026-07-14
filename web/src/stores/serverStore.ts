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
  clearServerSelection: () => void;
  setChannelPositions: (serverId: string, positions: { id: string; position: number }[]) => void;
  refreshChannels: (serverId: string) => Promise<void>;
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

// One recency lineage PER RESOURCE. The server LIST (servers, isLoadingServers)
// and the channel SELECTION (selectedServerId, channels, isLoadingChannels) are
// distinct resources: sharing one counter let a later fetchServers supersede an
// active selectServer without assuming its channel-loading responsibility,
// stranding the spinner (and vice versa).
let serverListSeq = 0;
let channelScopeSeq = 0;
export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  selectedServerId: null,
  channels: [],
  selectedChannelId: null,
  isLoadingServers: false,
  isLoadingChannels: false,
  error: null,

  fetchServers: async () => {
    // Session ownership + LIST-resource recency at entry. The auto-select branch
    // additionally claims the channel-selection lineage when (and only when) it
    // takes over that resource.
    const generation = captureSessionGeneration();
    const listSeq = ++serverListSeq;
    const listOwns = () => listSeq === serverListSeq && isSessionGenerationCurrent(generation);
    set({ isLoadingServers: true, error: null });
    try {
      const rawServers = await apiGetServers();
      if (!listOwns()) return;
      const servers = Array.isArray(rawServers) ? rawServers : [];

      // If no server is selected and we have servers, merge server list +
      // initial selection into a single state update to avoid cascading renders.
      if (!get().selectedServerId && servers.length > 0) {
        const chanSeq = ++channelScopeSeq; // taking over the channel resource
        const chanOwns = () => chanSeq === channelScopeSeq && isSessionGenerationCurrent(generation);
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
          if (!chanOwns()) return;
          const sorted = (Array.isArray(rawChannels) ? rawChannels : []).sort((a, b) => a.position - b.position);
          set({
            channels: sorted,
            isLoadingChannels: false,
            selectedChannelId: sorted.length > 0 ? sorted[0].id : null,
          });
        } catch {
          if (!chanOwns()) return;
          set({ isLoadingChannels: false });
        }
      } else {
        set({ servers, isLoadingServers: false });
      }
    } catch (err: unknown) {
      if (!listOwns()) return;
      const message = extractErrorMessage(err, 'Failed to load servers.');
      set({ isLoadingServers: false, error: message });
    }
  },

  selectServer: async (id: string) => {
    // Owned by session AND channel-scope recency: concurrent selectServer(A)/(B)
    // must leave the LAST selection's channels, never B selected with A's channels.
    const generation = captureSessionGeneration();
    const seq = ++channelScopeSeq;
    const owns = () => seq === channelScopeSeq && isSessionGenerationCurrent(generation);
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

  // Entering DM/empty scope INVALIDATES any in-flight server selection: a held
  // selectServer settling afterward must not install its channels (and select one)
  // while selectedServerId is null -- message rendering uses
  // selectedChannelId || selectedDMId, so the stale channel would shadow the DM.
  clearServerSelection: () => {
    channelScopeSeq += 1;
    // The claim supersedes any in-flight channel fetch whose finally can no longer
    // run -- settle its loading flag here.
    set({ selectedServerId: null, selectedChannelId: null, channels: [], isLoadingChannels: false });
  },

  // Reorder commits are FUNCTIONAL position applies, not wholesale snapshot
  // replacements: applying a position map to the CURRENT list preserves channels
  // created (or removed) by realtime events after the reorder was computed --
  // a snapshot replacement would erase (or resurrect) them. Scope-checked and
  // lineage-claiming.
  setChannelPositions: (serverId: string, positions: { id: string; position: number }[]) => {
    if (get().selectedServerId !== serverId) return;
    channelScopeSeq += 1;
    const posMap = new Map(positions.map((p) => [p.id, p.position]));
    set((state) => ({
      channels: state.channels
        .map((c) => (posMap.has(c.id) ? { ...c, position: posMap.get(c.id)! } : c))
        .sort((a, b) => a.position - b.position),
    }));
  },

  // A read-after-write refresh of the channel list, with full ownership: it is a
  // FETCH, so it claims the lineage at start and commits only while it still owns
  // it and the server is still selected -- a realtime commit mid-refresh
  // supersedes it (momentarily partial rather than wrong).
  refreshChannels: async (serverId: string) => {
    const generation = captureSessionGeneration();
    const seq = ++channelScopeSeq;
    try {
      const raw = await apiGetChannels(serverId);
      if (seq !== channelScopeSeq || !isSessionGenerationCurrent(generation)) return;
      if (get().selectedServerId !== serverId) return;
      set({ channels: (Array.isArray(raw) ? raw : []).sort((a, b) => a.position - b.position) });
    } catch { /* leave current state */ }
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
      serverListSeq += 1; // commit supersession: an older list snapshot must not erase it
      set((state) => ({
        servers: [...state.servers, server],
        isLoadingServers: false,
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
      channelScopeSeq += 1; // commit supersession: an older snapshot must not erase it
      set((state) => ({
        channels: [...state.channels, channel].sort(
          (a, b) => a.position - b.position
        ),
        isLoadingChannels: false, // this commit assumes any superseded fetch's loading
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
    serverListSeq += 1; // commit supersession: an older snapshot must not revert it
    set((state) => ({
      servers: state.servers.map((s) => (s.id === server.id ? { ...s, ...server } : s)),
      isLoadingServers: false,
    }));
  },

  addChannel: (channel: Channel) => {
    set((state) => {
      if (state.selectedServerId === channel.serverId) {
        const exists = state.channels.some((c) => c.id === channel.id);
        if (!exists) {
          // Commit supersession: this realtime write is newer truth than any
          // in-flight channels fetch -- an older snapshot settling later must not
          // erase it. (The superseded fetch's list is discarded; its loading flag
          // is cleared here since its own finally can no longer run.)
          channelScopeSeq += 1;
          return {
            channels: [...state.channels, channel].sort(
              (a, b) => a.position - b.position
            ),
            isLoadingChannels: false,
          };
        }
      }
      return {};
    });
  },

  updateChannel: (channel: Channel) => {
    // Claim UNCONDITIONALLY: even when the id is not locally present (e.g. the
    // list was cleared by an in-flight selectServer), this realtime event is
    // newer truth than that fetch's snapshot -- the snapshot must not commit
    // stale data over it.
    channelScopeSeq += 1;
    set((state) => {
      if (!state.channels.some((c) => c.id === channel.id)) {
        return { isLoadingChannels: false };
      }
      return {
        channels: state.channels.map((c) =>
          c.id === channel.id ? { ...c, ...channel } : c
        ),
        isLoadingChannels: false,
      };
    });
  },

  removeChannel: (channelId: string) => {
    channelScopeSeq += 1; // claim unconditionally (see updateChannel)
    set((state) => {
      if (!state.channels.some((c) => c.id === channelId)) {
        return { isLoadingChannels: false };
      }
      const remaining = state.channels.filter((c) => c.id !== channelId);
      const updates: Partial<ServerState> = { channels: remaining, isLoadingChannels: false };
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
    serverListSeq += 1; // commit supersession: an older snapshot must not resurrect it
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

