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
import { createLineage } from './lineage';
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
  removeChannel: (channelId: string, serverId?: string) => void;
  leaveServer: (serverId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  removeServer: (serverId: string) => void;
  reset: () => void;
}

// One reconciling lineage PER RESOURCE (see lineage.ts): the server LIST and the
// channel SELECTION are distinct resources. Mutations journal their functional
// application, so a fetch that overlaps them commits the snapshot WITH the
// mutations re-applied -- never discarding unaffected rows.
const serverListLineage = createLineage<Server>();
const channelLineage = createLineage<Channel>();

const sortChannels = (list: Channel[]) => [...list].sort((a, b) => a.position - b.position);
const upsertChannel = (channel: Channel) => (list: Channel[]) =>
  sortChannels([...list.filter((c) => c.id !== channel.id), channel]);
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
    const listToken = serverListLineage.startFetch();
    set({ isLoadingServers: true, error: null });
    try {
      const rawServers = await apiGetServers();
      if (!isSessionGenerationCurrent(generation)) return;
      const snapshot = Array.isArray(rawServers) ? rawServers : [];
      const outcome = serverListLineage.reconcile(listToken, snapshot);
      if (outcome.kind === 'superseded') return;
      const servers = outcome.kind === 'ok' ? outcome.list : get().servers;

      // If no server is selected and we have servers, merge server list +
      // initial selection into a single state update to avoid cascading renders.
      if (!get().selectedServerId && servers.length > 0) {
        const chanToken = channelLineage.startFetch(); // taking over the channel resource
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
          if (!isSessionGenerationCurrent(generation)) return;
          const chanOutcome = channelLineage.reconcile(
            chanToken,
            sortChannels(Array.isArray(rawChannels) ? rawChannels : [])
          );
          if (chanOutcome.kind === 'superseded') return;
          if (chanOutcome.kind === 'gap') {
            set({ isLoadingChannels: false });
            return;
          }
          set({
            channels: chanOutcome.list,
            isLoadingChannels: false,
            selectedChannelId: chanOutcome.list.length > 0 ? chanOutcome.list[0].id : null,
          });
        } catch {
          if (!isSessionGenerationCurrent(generation)) return;
          set({ isLoadingChannels: false });
        }
      } else {
        set({ servers, isLoadingServers: false });
      }
    } catch (err: unknown) {
      if (!isSessionGenerationCurrent(generation)) return;
      const message = extractErrorMessage(err, 'Failed to load servers.');
      set({ isLoadingServers: false, error: message });
    }
  },

  selectServer: async (id: string) => {
    // A fetch of the channel resource: a newer selection/barrier supersedes it;
    // mutations that overlap it are journaled and reconciled onto its snapshot.
    const generation = captureSessionGeneration();
    const token = channelLineage.startFetch();
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
      if (!isSessionGenerationCurrent(generation)) return;
      const outcome = channelLineage.reconcile(
        token,
        sortChannels(Array.isArray(rawChannels) ? rawChannels : [])
      );
      if (outcome.kind === 'superseded') return;
      if (outcome.kind === 'gap') {
        set({ isLoadingChannels: false });
        return;
      }
      // Merge channels + auto-select into a single state update
      set({
        channels: outcome.list,
        isLoadingChannels: false,
        selectedChannelId: outcome.list.length > 0 ? outcome.list[0].id : null,
      });
    } catch (err: unknown) {
      if (!isSessionGenerationCurrent(generation)) return;
      if (channelLineage.reconcile(token, []).kind === 'superseded') return;
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
    // A scope BARRIER: in-flight channel fetches are discarded outright (their
    // snapshots belong to a scope that no longer exists) and their loading flag is
    // settled here.
    channelLineage.barrier();
    set({ selectedServerId: null, selectedChannelId: null, channels: [], isLoadingChannels: false });
  },

  // Reorder commits are FUNCTIONAL position applies, not wholesale snapshot
  // replacements: applying a position map to the CURRENT list preserves channels
  // created (or removed) by realtime events after the reorder was computed --
  // a snapshot replacement would erase (or resurrect) them. Scope-checked and
  // lineage-claiming.
  setChannelPositions: (serverId: string, positions: { id: string; position: number }[]) => {
    if (get().selectedServerId !== serverId) return;
    const posMap = new Map(positions.map((p) => [p.id, p.position]));
    const apply = (list: Channel[]) =>
      sortChannels(list.map((c) => (posMap.has(c.id) ? { ...c, position: posMap.get(c.id)! } : c)));
    channelLineage.claim(apply); // journaled: reconciles onto any overlapping fetch
    set((state) => ({ channels: apply(state.channels) }));
  },

  // A read-after-write refresh of the channel list, with full ownership: it is a
  // FETCH, so it claims the lineage at start and commits only while it still owns
  // it and the server is still selected -- a realtime commit mid-refresh
  // supersedes it (momentarily partial rather than wrong).
  refreshChannels: async (serverId: string) => {
    const generation = captureSessionGeneration();
    const token = channelLineage.startFetch();
    try {
      const raw = await apiGetChannels(serverId);
      if (!isSessionGenerationCurrent(generation)) return;
      if (get().selectedServerId !== serverId) return;
      const outcome = channelLineage.reconcile(token, sortChannels(Array.isArray(raw) ? raw : []));
      if (outcome.kind !== 'ok') return;
      set({ channels: outcome.list });
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
      const applyServer = (list: Server[]) => [...list.filter((sv) => sv.id !== server.id), server];
      serverListLineage.claim(applyServer); // journaled: reconciles onto overlapping fetches
      set((state) => ({
        servers: applyServer(state.servers),
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
      // UPSERT (the server broadcasts CHANNEL_CREATE before the HTTP response
      // completes -- if the event appended first, this must not duplicate it),
      // journaled so an overlapping fetch reconciles it onto its snapshot.
      const apply = upsertChannel(channel);
      channelLineage.claim(apply);
      set((state) => ({ channels: apply(state.channels) }));
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
    const apply = (list: Server[]) =>
      list.map((sv) => (sv.id === server.id ? { ...sv, ...server } : sv));
    serverListLineage.claim(apply); // journaled: an older snapshot cannot revert it
    set((state) => ({ servers: apply(state.servers) }));
  },

  addChannel: (channel: Channel) => {
    // SCOPE-checked: an event for another joined server is not part of this
    // resource and must not touch its lineage (it would cancel/skew the selected
    // server's fetch). Same-scope events journal an UPSERT -- applied to current
    // state now, and re-applied onto any overlapping fetch's snapshot at commit.
    if (get().selectedServerId !== channel.serverId) return;
    const apply = upsertChannel(channel);
    channelLineage.claim(apply);
    set((state) => ({ channels: apply(state.channels) }));
  },

  updateChannel: (channel: Channel) => {
    if (get().selectedServerId !== channel.serverId) return; // other-server event
    const apply = (list: Channel[]) =>
      list.some((c) => c.id === channel.id)
        ? sortChannels(list.map((c) => (c.id === channel.id ? { ...c, ...channel } : c)))
        : list;
    channelLineage.claim(apply);
    set((state) => ({ channels: apply(state.channels) }));
  },

  removeChannel: (channelId: string, serverId?: string) => {
    // Scope check when the event carries its server; a removal is journaled so an
    // overlapping fetch's snapshot (which may still contain the row) drops it too.
    if (serverId && get().selectedServerId !== serverId) return;
    const apply = (list: Channel[]) => list.filter((c) => c.id !== channelId);
    channelLineage.claim(apply);
    set((state) => {
      const remaining = apply(state.channels);
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
    const apply = (list: Server[]) => list.filter((sv) => sv.id !== serverId);
    serverListLineage.claim(apply); // journaled: an older snapshot cannot resurrect it
    set((state) => {
      const remaining = apply(state.servers);
      if (state.selectedServerId === serverId) {
        // Removing the SELECTED server also barriers the channel resource: its
        // held channel fetch must not repopulate channels under the new scope.
        channelLineage.barrier();
        return {
          servers: remaining,
          selectedServerId: remaining[0]?.id || null,
          channels: [],
          selectedChannelId: null,
          isLoadingChannels: false,
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

