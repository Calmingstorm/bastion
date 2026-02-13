import { create } from 'zustand';
import type { ReadState } from '../types';
import { apiGetReadStates, apiAckChannel } from '../api/client';

interface UnreadState {
  readStates: Record<string, ReadState>; // channelId -> ReadState
  unreadChannels: Set<string>;
  fetchReadStates: () => Promise<void>;
  ackChannel: (channelId: string, messageId: string) => Promise<void>;
  markUnread: (channelId: string) => void;
  incrementMention: (channelId: string) => void;
  isUnread: (channelId: string) => boolean;
  getMentionCount: (channelId: string) => number;
  reset: () => void;
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  readStates: {},
  unreadChannels: new Set(),

  fetchReadStates: async () => {
    try {
      const rawStates = await apiGetReadStates();
      const states = Array.isArray(rawStates) ? rawStates : [];
      const map: Record<string, ReadState> = {};
      states.forEach((rs) => {
        map[rs.channelId] = rs;
      });
      set({ readStates: map });
    } catch {
      // Silent fail
    }
  },

  ackChannel: async (channelId: string, messageId: string) => {
    try {
      await apiAckChannel(channelId, messageId);
      set((state) => {
        const newUnread = new Set(state.unreadChannels);
        newUnread.delete(channelId);
        return {
          unreadChannels: newUnread,
          readStates: {
            ...state.readStates,
            [channelId]: {
              userId: '',
              channelId,
              lastMessageId: messageId,
              lastReadAt: new Date().toISOString(),
              mentionCount: 0,
            },
          },
        };
      });
    } catch {
      // Silent fail
    }
  },

  markUnread: (channelId: string) => {
    set((state) => {
      const newUnread = new Set(state.unreadChannels);
      newUnread.add(channelId);
      return { unreadChannels: newUnread };
    });
  },

  incrementMention: (channelId: string) => {
    set((state) => {
      const existing = state.readStates[channelId];
      return {
        readStates: {
          ...state.readStates,
          [channelId]: {
            ...existing,
            userId: existing?.userId || '',
            channelId,
            lastMessageId: existing?.lastMessageId,
            lastReadAt: existing?.lastReadAt || new Date().toISOString(),
            mentionCount: (existing?.mentionCount || 0) + 1,
          },
        },
      };
    });
  },

  isUnread: (channelId: string) => {
    return get().unreadChannels.has(channelId);
  },

  getMentionCount: (channelId: string) => {
    return get().readStates[channelId]?.mentionCount || 0;
  },

  reset: () => {
    set({ readStates: {}, unreadChannels: new Set() });
  },
}));
