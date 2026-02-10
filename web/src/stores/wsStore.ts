import { create } from 'zustand';
import { wsClient } from '../api/websocket';
import { useMessageStore } from './messageStore';
import { useServerStore } from './serverStore';
import { usePresenceStore } from './presenceStore';
import { useTypingStore } from './typingStore';
import { useUnreadStore } from './unreadStore';
import type { Message, Channel } from '../types';

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
        if (message.channelId !== selectedChannelId) {
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
      const payload = data as { channelId: string; mentionCount?: number };
      if (payload.channelId) {
        useUnreadStore.getState().markUnread(payload.channelId);
        if (payload.mentionCount) {
          useUnreadStore.getState().incrementMention(payload.channelId);
        }
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
