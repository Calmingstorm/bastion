import { create } from 'zustand';
import { wsClient } from '../api/websocket';
import { useMessageStore } from './messageStore';
import { useServerStore } from './serverStore';
import { usePresenceStore } from './presenceStore';
import { useTypingStore } from './typingStore';
import { useUnreadStore } from './unreadStore';
import { useAuthStore } from './authStore';
import { useDMStore } from './dmStore';
import type { Message, Channel, DMChannel, Server } from '../types';
import { eventBus } from '../utils/eventBus';
import { showNotification } from '../utils/notifications';

interface WSState {
  isConnected: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// resyncAfterReconnect refreshes the data a dropped socket may have missed. The
// active channel is re-fetched in MERGE mode so the reconnect preserves
// scrolled-in history and live changes rather than replacing them. Exported so
// the reconnect wiring is testable.
export function resyncAfterReconnect(): void {
  const selectedChannelId = useServerStore.getState().selectedChannelId;
  const selectedDMId = useDMStore.getState().selectedDMId;
  const activeChannelId = selectedChannelId || selectedDMId;
  if (activeChannelId) {
    void useMessageStore.getState().fetchMessages(activeChannelId, undefined, true);
  }
  eventBus.emit('bastion:member-update');
  void useDMStore.getState().fetchDMs();
  void useUnreadStore.getState().fetchReadStates();
}

export const useWSStore = create<WSState>((set) => ({
  isConnected: false,

  connect: (token: string) => {
    wsClient.disconnect();

    // Register handlers before connecting
    wsClient.on('MESSAGE_CREATE', (data: unknown) => {
      const payload = data as { message: Message; eventAt?: string } | Message;
      const message = 'message' in payload ? payload.message : payload;
      // The server's own emission time. Prefer it over message.createdAt for the
      // unread clock: bots may backdate createdAt (a presentation timestamp),
      // and a backdated mention is still a post-acknowledgment EVENT.
      const eventAt = 'message' in payload && payload.eventAt ? payload.eventAt : message.createdAt;
      if (message && message.channelId) {
        useMessageStore.getState().addMessage(message.channelId, message);

        // Mark as unread if not the active channel
        const selectedChannelId = useServerStore.getState().selectedChannelId;
        const selectedDMId = useDMStore.getState().selectedDMId;
        const activeChannelId = selectedChannelId || selectedDMId;
        if (message.channelId !== activeChannelId) {
          // Server-owned watermark first (message.seq); server-minted time as
          // the fallback tier for pre-seq servers.
          useUnreadStore.getState().markUnread(message.channelId, { seq: message.seq, at: eventAt });
        }

        // A message in a channel is proof a DM is ALIVE: clear any DM
        // close-tombstone BEFORE the refetch below, or the authoritative
        // response revealing a reopened DM gets filtered as a stale read.
        // Deliberately NOT asserted on the channel lineage: a message inserted
        // concurrently with a channel delete can be broadcast AFTER the delete
        // broadcast (different request goroutines), so it is not proof the
        // delete failed -- clearing that tombstone would let a stale snapshot
        // resurrect the deleted channel. Recovery for a genuinely failed
        // delete-after-broadcast belongs to the server-side ordering fix
        // (broadcast after commit).
        useDMStore.getState().noteChannelAlive(message.channelId);

        // If this message is for a channel not in our lists, refetch DMs
        // (handles reopened DMs where the user had closed the conversation)
        const { channels } = useServerStore.getState();
        const { dmChannels } = useDMStore.getState();
        const isKnownChannel =
          channels.some((c) => c.id === message.channelId) ||
          dmChannels.some((d) => d.id === message.channelId);
        if (!isKnownChannel) {
          useDMStore.getState().fetchDMs();
        }

        // Clear typing indicator for this user
        if (message.author) {
          useTypingStore.getState().removeTyping(message.channelId, message.author.id);
        }
      }
    });

    wsClient.on('MESSAGE_UPDATE', (data: unknown) => {
      const payload = data as { message: Message } | Message;
      const message = 'message' in payload ? payload.message : payload;
      if (message && message.channelId) {
        useMessageStore.getState().updateMessage(message.channelId, message);
      }
    });

    wsClient.on('MESSAGE_DELETE', (data: unknown) => {
      const payload = data as {
        channelId: string;
        messageId: string;
      };
      if (payload.channelId && payload.messageId) {
        useMessageStore
          .getState()
          .deleteMessage(payload.channelId, payload.messageId);
      }
    });

    wsClient.on('CHANNEL_CREATE', (data: unknown) => {
      const payload = data as { channel: Channel } | Channel;
      const channel = 'channel' in payload ? payload.channel : payload;
      if (channel) {
        useServerStore.getState().addChannel(channel);
      }
    });

    wsClient.on('CHANNEL_UPDATE', (data: unknown) => {
      const payload = data as { channel: Channel } | Channel;
      const channel = 'channel' in payload ? payload.channel : payload;
      // Reorder broadcasts arrive as partial {serverId, type} payloads -- they are
      // not complete channels and must not be treated as one (an id-less "update"
      // would journal a claim without a target).
      if (channel && channel.id) {
        useServerStore.getState().updateChannel(channel);
      }
    });

    wsClient.on('CHANNEL_DELETE', (data: unknown) => {
      const payload = data as { channelId: string; serverId: string };
      if (payload.channelId) {
        useServerStore.getState().removeChannel(payload.channelId, payload.serverId);
      }
    });

    wsClient.on('PRESENCE_UPDATE', (data: unknown) => {
      const payload = data as { userId: string; status: string };
      if (payload.userId && payload.status) {
        usePresenceStore.getState().setPresence(payload.userId, payload.status);
      }
    });

    wsClient.on('TYPING_START', (data: unknown) => {
      const payload = data as { channelId: string; userId: string };
      if (payload.channelId && payload.userId) {
        useTypingStore.getState().addTyping(payload.channelId, payload.userId);
      }
    });

    wsClient.on('NOTIFICATION', (data: unknown) => {
      const payload = data as {
        channelId: string; mentionCount?: number; seq?: number; createdAt?: string;
        senderName?: string; channelName?: string; content?: string;
      };
      if (payload.channelId) {
        // Server-owned watermark first (same contract as MESSAGE_CREATE): a
        // delayed notification whose message an ack already covered is dropped.
        // markUnread returns false when the event is already covered -- in that
        // case the badge must NOT be bumped and NO browser notification shown,
        // or a stale ping resurfaces for a message the user already read.
        const raised = useUnreadStore.getState().markUnread(payload.channelId, {
          seq: payload.seq,
          at: payload.createdAt,
        });
        if (!raised) return;
        if (payload.mentionCount) {
          useUnreadStore.getState().incrementMention(payload.channelId);
        }
        // Browser notification when tab is hidden
        if (payload.senderName) {
          const title = payload.channelName
            ? `${payload.senderName} in #${payload.channelName}`
            : payload.senderName;
          showNotification(title, payload.content || 'mentioned you');
        }
      }
    });

    wsClient.on('MEMBER_KICK', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId && payload.userId) {
        const { user } = useAuthStore.getState();
        if (user && payload.userId === user.id) {
          // We were kicked — remove the server through the store action, which
          // journals the removal (a held server-list snapshot cannot resurrect
          // it), barriers the channel resource when it was selected, and
          // auto-reselects the next server.
          useServerStore.getState().removeServer(payload.serverId);
        } else {
          // Someone else was kicked — refresh member list
          eventBus.emit('bastion:member-update', payload);
        }
      }
    });

    wsClient.on('REACTION_ADD', (data: unknown) => {
      const payload = data as { channelId: string; messageId: string; userId: string; emoji: string };
      if (payload.channelId && payload.messageId && payload.emoji) {
        useMessageStore.getState().addReaction(payload.channelId, payload.messageId, payload.emoji, payload.userId);
      }
    });

    wsClient.on('REACTION_REMOVE', (data: unknown) => {
      const payload = data as { channelId: string; messageId: string; userId: string; emoji: string };
      if (payload.channelId && payload.messageId && payload.emoji) {
        useMessageStore.getState().removeReaction(payload.channelId, payload.messageId, payload.emoji, payload.userId);
      }
    });

    wsClient.on('DM_CREATE', (data: unknown) => {
      const dm = data as DMChannel;
      if (dm && dm.id) {
        // Unconditional: addDM upserts (replacing any stale same-ID object) and
        // claims the lineage -- gating on local novelty here would let an older
        // fetch snapshot replace the list.
        useDMStore.getState().addDM(dm);
      }
    });

    wsClient.on('SERVER_MEMBER_LEAVE', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId && payload.userId) {
        const { user } = useAuthStore.getState();
        if (user && payload.userId === user.id) {
          // We left (from another session) — remove the server
          useServerStore.getState().removeServer(payload.serverId);
        } else {
          // Someone else left — refresh member list
          eventBus.emit('bastion:member-update', payload);
        }
      }
    });

    wsClient.on('SERVER_DELETE', (data: unknown) => {
      const payload = data as { serverId: string };
      if (payload.serverId) {
        useServerStore.getState().removeServer(payload.serverId);
      }
    });

    wsClient.on('MESSAGE_PIN', (data: unknown) => {
      const payload = data as { channelId: string; messageId: string };
      if (payload.channelId) {
        eventBus.emit('bastion:pin-update', payload);
      }
    });

    wsClient.on('MESSAGE_UNPIN', (data: unknown) => {
      const payload = data as { channelId: string; messageId: string };
      if (payload.channelId) {
        eventBus.emit('bastion:pin-update', payload);
      }
    });

    wsClient.on('MEMBER_NICKNAME_UPDATE', (data: unknown) => {
      const payload = data as { serverId: string; userId: string; nickname: string };
      if (payload.serverId) {
        eventBus.emit('bastion:member-update', payload);
      }
    });

    wsClient.on('SERVER_MEMBER_JOIN', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId) {
        const { selectedServerId } = useServerStore.getState();
        // Refetch member list if viewing the server the new member joined
        if (selectedServerId === payload.serverId) {
          // Dispatch a custom event that MemberList can listen for
          eventBus.emit('bastion:member-join', payload);
        }
      }
    });

    wsClient.on('MEMBER_BAN', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId && payload.userId) {
        const { user } = useAuthStore.getState();
        if (user && payload.userId === user.id) {
          // We were banned — same store-action path as a kick (journaled removal,
          // channel barrier when selected, auto-reselect).
          useServerStore.getState().removeServer(payload.serverId);
        } else {
          // Someone else was banned — refresh member list
          eventBus.emit('bastion:member-update', payload);
        }
      }
    });

    wsClient.on('MEMBER_TIMEOUT', (data: unknown) => {
      const payload = data as { serverId: string; userId: string; timedOutUntil: string };
      if (payload.serverId) {
        // Refresh member list so timeout indicator appears
        eventBus.emit('bastion:member-update', payload);
      }
    });

    // Role events — refresh member list (roles affect display)
    wsClient.on('ROLE_CREATE', () => {
      eventBus.emit('bastion:member-update');
    });
    wsClient.on('ROLE_UPDATE', () => {
      eventBus.emit('bastion:member-update');
    });
    wsClient.on('ROLE_DELETE', () => {
      eventBus.emit('bastion:member-update');
    });
    wsClient.on('ROLE_ASSIGNED', () => {
      eventBus.emit('bastion:member-update');
    });
    wsClient.on('ROLE_REMOVED', () => {
      eventBus.emit('bastion:member-update');
    });

    // Server update — update server in store directly
    wsClient.on('SERVER_UPDATE', (data: unknown) => {
      const server = data as Server;
      if (server && server.id) {
        useServerStore.getState().updateServer(server);
      }
    });

    // Category events — dispatch custom event so category-listing components can refetch
    wsClient.on('CATEGORY_CREATE', (data: unknown) => {
      const payload = data as { serverId?: string };
      eventBus.emit('bastion:category-update', payload);
    });
    wsClient.on('CATEGORY_UPDATE', (data: unknown) => {
      const payload = data as { serverId?: string };
      eventBus.emit('bastion:category-update', payload);
    });
    wsClient.on('CATEGORY_DELETE', (data: unknown) => {
      const payload = data as { serverId?: string };
      eventBus.emit('bastion:category-update', payload);
    });

    // Set own presence to online when WebSocket opens (or reopens after reconnect).
    // The server also broadcasts PRESENCE_UPDATE but there's a race where the
    // broadcast can fire before our channel subscriptions are processed.
    wsClient.on('CONNECTED', (data: unknown) => {
      const { isReconnect } = (data as { isReconnect?: boolean }) || {};
      const currentUser = useAuthStore.getState().user;
      if (currentUser) {
        usePresenceStore.getState().setPresence(currentUser.id, 'online');
      }
      set({ isConnected: true });

      if (isReconnect) {
        resyncAfterReconnect();
      }
    });

    wsClient.connect(token);

    // Start heartbeat for presence (every 60s)
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    heartbeatInterval = setInterval(() => {
      wsClient.send('HEARTBEAT');
    }, 60000);
  },

  disconnect: () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    wsClient.disconnect();
    set({ isConnected: false });
  },
}));
