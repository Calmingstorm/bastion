import { create } from 'zustand';
import type { Message } from '../types';
import { apiGetMessages, apiSendMessage, apiEditMessage, apiDeleteMessage } from '../api/client';
import { extractErrorMessage } from '../utils/errors';
import { eventBus } from '../utils/eventBus';

interface MessageState {
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  isLoading: Record<string, boolean>;
  error: string | null;
  replyingTo: Message | null;
  setReplyingTo: (msg: Message | null) => void;
  fetchMessages: (channelId: string, before?: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, replyToId?: string) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => Promise<void>;
  requestDeleteMessage: (channelId: string, messageId: string) => Promise<void>;
  addMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, message: Message) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => void;
  removeReaction: (channelId: string, messageId: string, emoji: string, userId: string) => void;
  reset: () => void;
}

const MESSAGE_LIMIT = 50;

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  hasMore: {},
  isLoading: {},
  error: null,
  replyingTo: null,

  setReplyingTo: (msg: Message | null) => set({ replyingTo: msg }),

  fetchMessages: async (channelId: string, before?: string) => {
    const state = get();

    // Prevent duplicate loading
    if (state.isLoading[channelId]) return;

    set((s) => ({
      isLoading: { ...s.isLoading, [channelId]: true },
      error: null,
    }));

    try {
      const rawFetched = await apiGetMessages(channelId, before, MESSAGE_LIMIT);
      const fetched = Array.isArray(rawFetched) ? rawFetched : [];
      // API returns messages in DESC order (newest first); reverse to ASC (oldest first)
      fetched.reverse();

      set((s) => {
        const existing = s.messages[channelId] || [];

        if (before) {
          // Loading older messages: prepend (fetched is now ASC, so oldest first)
          const existingIds = new Set(existing.map((m) => m.id));
          const newMessages = fetched.filter((m) => !existingIds.has(m.id));
          return {
            messages: {
              ...s.messages,
              [channelId]: [...newMessages, ...existing],
            },
            hasMore: {
              ...s.hasMore,
              [channelId]: fetched.length === MESSAGE_LIMIT,
            },
            isLoading: { ...s.isLoading, [channelId]: false },
          };
        }

        // Initial load
        return {
          messages: {
            ...s.messages,
            [channelId]: fetched,
          },
          hasMore: {
            ...s.hasMore,
            [channelId]: fetched.length === MESSAGE_LIMIT,
          },
          isLoading: { ...s.isLoading, [channelId]: false },
        };
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to load messages.');
      set((s) => ({
        isLoading: { ...s.isLoading, [channelId]: false },
        error: message,
      }));
    }
  },

  editMessage: async (channelId: string, messageId: string, content: string) => {
    try {
      const updated = await apiEditMessage(channelId, messageId, content);
      get().updateMessage(channelId, updated);
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to edit message.');
      set({ error: errMsg });
      throw new Error(errMsg);
    }
  },

  requestDeleteMessage: async (channelId: string, messageId: string) => {
    try {
      await apiDeleteMessage(channelId, messageId);
      get().deleteMessage(channelId, messageId);
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to delete message.');
      set({ error: errMsg });
      throw new Error(errMsg);
    }
  },

  sendMessage: async (channelId: string, content: string, replyToId?: string) => {
    try {
      const message = await apiSendMessage(channelId, content, replyToId);
      // Add the message optimistically (the WebSocket might also deliver it,
      // but addMessage deduplicates)
      get().addMessage(channelId, message);
      // Signal message list to scroll to bottom for own messages
      eventBus.emit('bastion:message-sent');
    } catch (err: unknown) {
      const errMsg = extractErrorMessage(err, 'Failed to send message.');
      set({ error: errMsg });
      throw new Error(errMsg);
    }
  },

  addMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId] || [];
      // Deduplicate: don't add if message already exists
      if (existing.some((m) => m.id === message.id)) {
        return {};
      }
      return {
        messages: {
          ...state.messages,
          [channelId]: [...existing, message],
        },
      };
    });
  },

  updateMessage: (channelId: string, message: Message) => {
    set((state) => {
      const existing = state.messages[channelId];
      if (!existing) return {};
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) =>
            m.id === message.id ? message : m
          ),
        },
      };
    });
  },

  deleteMessage: (channelId: string, messageId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      if (!existing) return {};
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.filter((m) => m.id !== messageId),
        },
      };
    });
  },

  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      if (!existing) return {};
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = [...(m.reactions || [])];
            const idx = reactions.findIndex((r) => r.emoji === emoji);
            if (idx >= 0) {
              if (!reactions[idx].users.includes(userId)) {
                reactions[idx] = {
                  ...reactions[idx],
                  count: reactions[idx].count + 1,
                  users: [...reactions[idx].users, userId],
                };
              }
            } else {
              reactions.push({ emoji, count: 1, users: [userId] });
            }
            return { ...m, reactions };
          }),
        },
      };
    });
  },

  removeReaction: (channelId: string, messageId: string, emoji: string, userId: string) => {
    set((state) => {
      const existing = state.messages[channelId];
      if (!existing) return {};
      return {
        messages: {
          ...state.messages,
          [channelId]: existing.map((m) => {
            if (m.id !== messageId) return m;
            const reactions = (m.reactions || [])
              .map((r) => {
                if (r.emoji !== emoji) return r;
                const users = r.users.filter((u) => u !== userId);
                return { ...r, count: users.length, users };
              })
              .filter((r) => r.count > 0);
            return { ...m, reactions };
          }),
        },
      };
    });
  },

  reset: () => {
    set({
      messages: {},
      hasMore: {},
      isLoading: {},
      error: null,
      replyingTo: null,
    });
  },
}));

