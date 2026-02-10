import { create } from 'zustand';
import { wsClient } from '../api/websocket';
import { useMessageStore } from './messageStore';
import { useServerStore } from './serverStore';
import type { Message, Channel } from '../types';

interface WSState {
  isConnected: boolean;
  connect: (token: string) => void;
  disconnect: () => void;
}

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

    wsClient.connect(token);
    set({ isConnected: true });
  },

  disconnect: () => {
    wsClient.disconnect();
    set({ isConnected: false });
  },
}));
