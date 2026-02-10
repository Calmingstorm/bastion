import { create } from 'zustand';
import { wsClient } from '../api/websocket';
import { useMessageStore } from './messageStore';
import { useServerStore } from './serverStore';
import { usePresenceStore } from './presenceStore';
import { useTypingStore } from './typingStore';
import { useUnreadStore } from './unreadStore';
import { useAuthStore } from './authStore';
import { useDMStore } from './dmStore';
import type { Message, Channel, DMChannel } from '../types';

interface WSState {
  isConnected: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export const useWSStore = create<WSState>((set) => ({
  isConnected: false,

  connect: (token: string) => {
    wsClient.disconnect();

    // Register handlers before connecting
    wsClient.on('MESSAGE_CREATE', (data: unknown) => {
      const payload = data as { message: Message } | Message;
      const message = 'message' in payload ? payload.message : payload;
      if (message && message.channelId) {
        useMessageStore.getState().addMessage(message.channelId, message);

        // Mark as unread if not the active channel
        const selectedChannelId = useServerStore.getState().selectedChannelId;
        const selectedDMId = useDMStore.getState().selectedDMId;
        const activeChannelId = selectedChannelId || selectedDMId;
        if (message.channelId !== activeChannelId) {
          useUnreadStore.getState().markUnread(message.channelId);
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
      if (channel) {
        useServerStore.getState().updateChannel(channel);
      }
    });

    wsClient.on('CHANNEL_DELETE', (data: unknown) => {
      const payload = data as { channelId: string; serverId: string };
      if (payload.channelId) {
        useServerStore.getState().removeChannel(payload.channelId);
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
        channelId: string; mentionCount?: number;
        senderName?: string; channelName?: string; content?: string;
      };
      if (payload.channelId) {
        useUnreadStore.getState().markUnread(payload.channelId);
        if (payload.mentionCount) {
          useUnreadStore.getState().incrementMention(payload.channelId);
        }
        // Browser notification when tab is hidden
        if (payload.senderName && 'Notification' in window &&
            Notification.permission === 'granted' && document.hidden) {
          const title = payload.channelName
            ? `${payload.senderName} in #${payload.channelName}`
            : payload.senderName;
          new Notification(title, {
            body: payload.content || 'mentioned you',
            icon: '/favicon.ico',
          });
        }
      }
    });

    wsClient.on('MEMBER_KICK', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId && payload.userId) {
        const { user } = useAuthStore.getState();
        if (user && payload.userId === user.id) {
          // We were kicked — remove the server from our list
          const { servers, selectedServerId } = useServerStore.getState();
          const remaining = servers.filter((s) => s.id !== payload.serverId);
          if (selectedServerId === payload.serverId) {
            useServerStore.setState({ servers: remaining, selectedServerId: remaining[0]?.id || null, channels: [], selectedChannelId: null });
            if (remaining[0]) useServerStore.getState().selectServer(remaining[0].id);
          } else {
            useServerStore.setState({ servers: remaining });
          }
        } else {
          // Someone else was kicked — refresh member list
          window.dispatchEvent(new CustomEvent('bastion:member-update', { detail: payload }));
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
        const { dmChannels } = useDMStore.getState();
        const exists = dmChannels.some((d) => d.id === dm.id);
        if (!exists) {
          useDMStore.setState({ dmChannels: [dm, ...dmChannels] });
        }
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
          window.dispatchEvent(new CustomEvent('bastion:member-update', { detail: payload }));
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
        window.dispatchEvent(new CustomEvent('bastion:pin-update', { detail: payload }));
      }
    });

    wsClient.on('MESSAGE_UNPIN', (data: unknown) => {
      const payload = data as { channelId: string; messageId: string };
      if (payload.channelId) {
        window.dispatchEvent(new CustomEvent('bastion:pin-update', { detail: payload }));
      }
    });

    wsClient.on('MEMBER_NICKNAME_UPDATE', (data: unknown) => {
      const payload = data as { serverId: string; userId: string; nickname: string };
      if (payload.serverId) {
        window.dispatchEvent(new CustomEvent('bastion:member-update', { detail: payload }));
      }
    });

    wsClient.on('SERVER_MEMBER_JOIN', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId) {
        const { selectedServerId } = useServerStore.getState();
        // Refetch member list if viewing the server the new member joined
        if (selectedServerId === payload.serverId) {
          // Dispatch a custom event that MemberList can listen for
          window.dispatchEvent(new CustomEvent('bastion:member-join', { detail: payload }));
        }
      }
    });

    wsClient.on('MEMBER_BAN', (data: unknown) => {
      const payload = data as { serverId: string; userId: string };
      if (payload.serverId && payload.userId) {
        const { user } = useAuthStore.getState();
        if (user && payload.userId === user.id) {
          // We were banned — remove the server from our list
          const { servers, selectedServerId } = useServerStore.getState();
          const remaining = servers.filter((s) => s.id !== payload.serverId);
          if (selectedServerId === payload.serverId) {
            useServerStore.setState({ servers: remaining, selectedServerId: remaining[0]?.id || null, channels: [], selectedChannelId: null });
            if (remaining[0]) useServerStore.getState().selectServer(remaining[0].id);
          } else {
            useServerStore.setState({ servers: remaining });
          }
        } else {
          // Someone else was banned — refresh member list
          window.dispatchEvent(new CustomEvent('bastion:member-update', { detail: payload }));
        }
      }
    });

    wsClient.on('MEMBER_TIMEOUT', (data: unknown) => {
      const payload = data as { serverId: string; userId: string; timedOutUntil: string };
      if (payload.serverId) {
        // Refresh member list so timeout indicator appears
        window.dispatchEvent(new CustomEvent('bastion:member-update', { detail: payload }));
      }
    });

    wsClient.connect(token);
    set({ isConnected: true });

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
