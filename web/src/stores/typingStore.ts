import { create } from 'zustand';

interface TypingState {
  // channelId -> { userId -> expireTimeout }
  typing: Record<string, Record<string, ReturnType<typeof setTimeout>>>;
  addTyping: (channelId: string, userId: string) => void;
  removeTyping: (channelId: string, userId: string) => void;
  getTypingUsers: (channelId: string) => string[];
  reset: () => void;
}

const TYPING_DURATION = 8000; // 8 seconds

export const useTypingStore = create<TypingState>((set, get) => ({
  typing: {},

  addTyping: (channelId: string, userId: string) => {
    const state = get();
    const channelTyping = state.typing[channelId] || {};

    // Clear existing timeout for this user
    if (channelTyping[userId]) {
      clearTimeout(channelTyping[userId]);
    }

    // Set auto-expire
    const timeout = setTimeout(() => {
      get().removeTyping(channelId, userId);
    }, TYPING_DURATION);

    set((s) => ({
      typing: {
        ...s.typing,
        [channelId]: {
          ...s.typing[channelId],
          [userId]: timeout,
        },
      },
    }));
  },

  removeTyping: (channelId: string, userId: string) => {
    set((state) => {
      const channelTyping = { ...state.typing[channelId] };
      if (channelTyping[userId]) {
        clearTimeout(channelTyping[userId]);
        delete channelTyping[userId];
      }
      return {
        typing: {
          ...state.typing,
          [channelId]: channelTyping,
        },
      };
    });
  },

  getTypingUsers: (channelId: string) => {
    const channelTyping = get().typing[channelId];
    if (!channelTyping) return [];
    return Object.keys(channelTyping);
  },

  reset: () => {
    // Clear all timeouts
    const state = get();
    Object.values(state.typing).forEach((channelTyping) => {
      Object.values(channelTyping).forEach((timeout) => clearTimeout(timeout));
    });
    set({ typing: {} });
  },
}));
