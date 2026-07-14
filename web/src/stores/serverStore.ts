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
  addServer: (server: Server) => void;
  updateServer: (server: Server) => void;
  addChannel: (channel: Channel) => void;
  updateChannel: (channel: Channel) => void;
  removeChannel: (channelId: string, serverId: string) => void;
  leaveServer: (serverId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  removeServer: (serverId: string) => void;
  reset: () => void;
}

// One reconciling lineage PER RESOURCE (see lineage.ts): the server LIST and the
// channel SELECTION are distinct resources. Mutations journal their functional
// application, so a fetch that overlaps them commits the snapshot WITH the
// mutations re-applied -- never discarding unaffected rows.
const serverListLineage = createLineage<Server>((sv) => sv.id);
const channelLineage = createLineage<Channel>((c) => c.id);

const sortChannels = (list: Channel[]) => [...list].sort((a, b) => a.position - b.position);
// Upserts MERGE rather than replace: a whole-object event (a CHANNEL_CREATE /
// DM_CREATE broadcast, or its journal entry replayed onto a fresher snapshot)
// may be SILENT on fields the current row carries -- receipt order is not data
// freshness. Fields the payload carries win; fields it is silent on survive.
const upsertChannel = (channel: Channel) => (list: Channel[]) => {
  const existing = list.find((c) => c.id === channel.id);
  const merged = existing ? { ...existing, ...channel } : channel;
  return sortChannels([...list.filter((c) => c.id !== channel.id), merged]);
};
const upsertServer = (server: Server) => (list: Server[]) => {
  const existing = list.find((sv) => sv.id === server.id);
  const merged = existing ? { ...existing, ...server } : server;
  return [...list.filter((sv) => sv.id !== server.id), merged];
};
// Selection is RECONCILED with the committed list, never blindly defaulted: a
// selection made while a fetch was in flight (a create's auto-select, a user
// click on a realtime row) wins over the fetch's first-channel default.
const normalizeSelection = (list: Channel[], current: string | null) =>
  current && list.some((c) => c.id === current) ? current : (list[0]?.id ?? null);

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
    let listToken = serverListLineage.startFetch();
    set({ isLoadingServers: true, error: null });
    try {
      let servers: Server[];
      for (;;) {
        const rawServers = await apiGetServers();
        if (!isSessionGenerationCurrent(generation)) return;
        const outcome = serverListLineage.reconcile(
          listToken,
          Array.isArray(rawServers) ? rawServers : []
        );
        if (outcome.kind === 'superseded') return;
        if (outcome.kind === 'gap') {
          // The journal outran this fetch mid-flight; its snapshot cannot be
          // reconciled, so RETRY for a fresh one -- keeping partial state would
          // silently discard the fetch's authoritative rows. Terminates: a newer
          // fetch or barrier exits via `superseded`, and gapping again requires
          // another JOURNAL_CAP claims during the retry's own flight.
          listToken = serverListLineage.startFetch();
          continue;
        }
        servers = outcome.list;
        break;
      }

      // The SELECTION is reconciled with the committed list too: if the
      // authoritative list no longer contains the selected server (kicked or the
      // server deleted while this client was away -- no event to catch), the
      // selection must not dangle over channels of a server we are not in.
      const selectedAtCommit = get().selectedServerId;
      if (selectedAtCommit && !servers.some((sv) => sv.id === selectedAtCommit)) {
        channelLineage.barrier(); // its held channel fetch belongs to a dead scope
        set({
          servers,
          isLoadingServers: false,
          selectedServerId: servers[0]?.id ?? null,
          selectedChannelId: null,
          channels: [],
          isLoadingChannels: false,
        });
        const next = get().selectedServerId;
        if (next) void get().selectServer(next); // total: never rejects
        return;
      }

      // If no server is selected and we have servers, merge server list +
      // initial selection into a single state update to avoid cascading renders.
      if (!get().selectedServerId && servers.length > 0) {
        let chanToken = channelLineage.startFetch(servers[0].id); // taking over the channel resource
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
          for (;;) {
            const rawChannels = await apiGetChannels(servers[0].id);
            if (!isSessionGenerationCurrent(generation)) return;
            const chanOutcome = channelLineage.reconcile(
              chanToken,
              sortChannels(Array.isArray(rawChannels) ? rawChannels : [])
            );
            if (chanOutcome.kind === 'superseded') return;
            if (chanOutcome.kind === 'gap') {
              chanToken = channelLineage.startFetch(servers[0].id);
              continue;
            }
            set((state) => ({
              channels: chanOutcome.list,
              isLoadingChannels: false,
              selectedChannelId: normalizeSelection(chanOutcome.list, state.selectedChannelId),
            }));
            return;
          }
        } catch {
          if (!isSessionGenerationCurrent(generation)) return;
          // Only the OWNING fetch may settle the spinner: a superseded
          // auto-selection failure belongs to a selection that no longer exists.
          if (!channelLineage.owns(chanToken)) return;
          set({ isLoadingChannels: false });
        }
      } else {
        set({ servers, isLoadingServers: false });
      }
    } catch (err: unknown) {
      if (!isSessionGenerationCurrent(generation)) return;
      // FAILURE commits are ownership-checked like success commits: an older
      // fetch's rejection must not overwrite a newer fetch's state or spinner.
      if (!serverListLineage.owns(listToken)) return;
      const message = extractErrorMessage(err, 'Failed to load servers.');
      set({ isLoadingServers: false, error: message });
    }
  },

  selectServer: async (id: string) => {
    // A fetch of the channel resource: a newer selection/barrier supersedes it;
    // mutations that overlap it are journaled and reconciled onto its snapshot.
    const generation = captureSessionGeneration();
    let token = channelLineage.startFetch(id); // scoped: this fetch enumerates `id`'s channels
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
      for (;;) {
        const rawChannels = await apiGetChannels(id);
        if (!isSessionGenerationCurrent(generation)) return;
        const outcome = channelLineage.reconcile(
          token,
          sortChannels(Array.isArray(rawChannels) ? rawChannels : [])
        );
        if (outcome.kind === 'superseded') return;
        if (outcome.kind === 'gap') {
          token = channelLineage.startFetch(id); // retry with a fresh snapshot
          continue;
        }
        // Merge channels + selection into a single state update. The selection
        // is normalized, not defaulted: a mid-flight creation's auto-select (or
        // a user click on a realtime row) survives this commit.
        set((state) => ({
          channels: outcome.list,
          isLoadingChannels: false,
          selectedChannelId: normalizeSelection(outcome.list, state.selectedChannelId),
        }));
        return;
      }
    } catch (err: unknown) {
      if (!isSessionGenerationCurrent(generation)) return;
      if (!channelLineage.owns(token)) return; // the newer owner settles the spinner
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
  // FETCH, so it claims the lineage at start -- and because that claim may have
  // SUPERSEDED a selection fetch, its settlement also settles the loading flag
  // and normalizes the selection the superseded fetch never got to make.
  refreshChannels: async (serverId: string) => {
    const generation = captureSessionGeneration();
    // Scope check BEFORE claiming: a stale read-after-write callback for a server
    // we no longer hold must not supersede the ACTIVE selection's fetch -- it
    // would strand a spinner neither request settles (the refresh scope-bails,
    // the selection is superseded).
    if (get().selectedServerId !== serverId) return;
    let token = channelLineage.startFetch(serverId); // scoped fetch
    try {
      for (;;) {
        const raw = await apiGetChannels(serverId);
        if (!isSessionGenerationCurrent(generation)) return;
        // Scope moved on (clear/removal barriered, or a newer selection owns the
        // resource) -- whoever moved it settled or owns the loading flag.
        if (get().selectedServerId !== serverId) return;
        const outcome = channelLineage.reconcile(token, sortChannels(Array.isArray(raw) ? raw : []));
        if (outcome.kind === 'superseded') return;
        if (outcome.kind === 'gap') {
          token = channelLineage.startFetch(serverId); // retry with a fresh snapshot
          continue;
        }
        set((state) => ({
          channels: outcome.list,
          isLoadingChannels: false,
          selectedChannelId: normalizeSelection(outcome.list, state.selectedChannelId),
        }));
        return;
      }
    } catch {
      if (!isSessionGenerationCurrent(generation)) return;
      if (!channelLineage.owns(token)) return;
      // Never strand a superseded selection's spinner: this fetch owns the
      // resource at failure, so it settles loading even though it never set it.
      set({ isLoadingChannels: false });
    }
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
      const applyServer = upsertServer(server);
      // Journaled + asserted: reconciles onto overlapping fetches and clears any
      // tombstone for this id (the server has asserted its existence).
      serverListLineage.claim(applyServer, { asserts: [server.id] });
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
      channelLineage.claim(apply, { asserts: [channel.id] });
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

  // Join-flow commit: the HTTP join response IS a server-existence assertion, so
  // it clears any tombstone from an earlier leave/kick/ban -- a rejoin must show
  // the server immediately, not after some later fetch cycles past the tombstone.
  addServer: (server: Server) => {
    const apply = upsertServer(server);
    serverListLineage.claim(apply, { asserts: [server.id] });
    set((state) => ({ servers: apply(state.servers) }));
  },

  updateServer: (server: Server) => {
    const present = get().servers.some((sv) => sv.id === server.id);
    const apply = (list: Server[]) =>
      list.map((sv) => (sv.id === server.id ? { ...sv, ...server } : sv));
    // Assert existence only when the update actually applied: a DELAYED no-op
    // update (sent before a deletion, delivered after) must not clear the
    // deletion's tombstone and reopen the resurrection window.
    serverListLineage.claim(apply, present ? { asserts: [server.id] } : undefined);
    set((state) => ({ servers: apply(state.servers) }));
  },

  addChannel: (channel: Channel) => {
    // SCOPE-checked: an event for another joined server is not part of this
    // resource and must not touch its lineage (it would cancel/skew the selected
    // server's fetch). Same-scope events journal an UPSERT -- applied to current
    // state now, and re-applied onto any overlapping fetch's snapshot at commit.
    if (get().selectedServerId !== channel.serverId) return;
    const apply = upsertChannel(channel);
    channelLineage.claim(apply, { asserts: [channel.id] });
    set((state) => ({ channels: apply(state.channels) }));
  },

  updateChannel: (channel: Channel) => {
    if (get().selectedServerId !== channel.serverId) return; // other-server event
    const present = get().channels.some((c) => c.id === channel.id);
    const apply = (list: Channel[]) =>
      list.some((c) => c.id === channel.id)
        ? sortChannels(list.map((c) => (c.id === channel.id ? { ...c, ...channel } : c)))
        : list;
    // Assert only when the target is present (see updateServer): a stale update
    // for a just-deleted channel must not clear the deletion's tombstone.
    channelLineage.claim(apply, present ? { asserts: [channel.id] } : undefined);
    set((state) => ({ channels: apply(state.channels) }));
  },

  removeChannel: (channelId: string, serverId: string) => {
    // NOT scope-gated, unlike add/update: removals are subtractive (a foreign id
    // can never collide with the selected list, so the claim and the local filter
    // are harmless no-ops cross-scope), and the tombstone MUST outlive the current
    // scope -- selecting the event's server later, while its held fetch returns a
    // pre-delete snapshot, would otherwise resurrect a channel whose delete event
    // was silently dropped here. The removal is journaled AND tombstoned: the
    // backend broadcasts CHANNEL_DELETE before its database deletion executes, so
    // a fetch STARTING after this event can still return a snapshot containing
    // the row -- the tombstone stops that resurrection where the journal (which
    // only covers post-start claims) cannot.
    // The tombstone is SCOPED to the channel's OWN server -- required, never
    // inferred from the current selection: a delete started under server A but
    // settling under server B would otherwise be scoped to B, where B's next
    // fetch omits the id vacuously and retires it, letting a stale A snapshot
    // resurrect the channel. Every caller knows the channel's server (the event
    // payload carries it; the delete handlers captured it for their API call).
    const apply = (list: Channel[]) => list.filter((c) => c.id !== channelId);
    channelLineage.claim(apply, { removes: [channelId], scope: serverId });
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
    // Tombstoned, but tombstones are race covers, not permanence: leave, kick,
    // and ban are all reversible -- fetch retirement (see lineage.ts) plus the
    // join flow's addServer assertion keep a rejoin visible.
    const wasSelected = get().selectedServerId === serverId;
    const apply = (list: Server[]) => list.filter((sv) => sv.id !== serverId);
    serverListLineage.claim(apply, { removes: [serverId] });
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
    // ONLY a removal of the selected server re-selects (its replacement needs
    // channels fetched). Removing an unselected server must not churn the
    // current view -- re-selecting it would clear channels, refetch, and yank
    // the user back to the first channel.
    if (!wasSelected) return;
    const { selectedServerId, servers } = get();
    if (selectedServerId && servers.length > 0) {
      get().selectServer(selectedServerId);
    }
  },

  reset: () => {
    // Full lineage reset, not just a barrier: held fetches are superseded AND
    // accumulated tombstones/journal are dropped -- account A's removals must
    // not filter account B's fetches on the same client.
    serverListLineage.reset();
    channelLineage.reset();
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
