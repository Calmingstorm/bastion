import { create } from 'zustand';
import type { User } from '../types';
import {
  apiLogin,
  apiRegister,
  apiGetMe,
  setTokens as persistTokens,
  clearTokens,
} from '../api/client';
import { extractErrorMessage } from '../utils/errors';
import { storage } from '../utils/storage';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (
    username: string,
    email: string,
    password: string
  ) => Promise<void>;
  logout: () => void;
  setTokens: (access: string, refresh: string) => void;
  loadFromStorage: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiLogin(email, password);
      persistTokens(response.accessToken, response.refreshToken);
      storage.setItem('user', JSON.stringify(response.user));
      set({
        user: response.user,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Login failed. Please check your credentials.');
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  register: async (username: string, email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiRegister(username, email, password);
      persistTokens(response.accessToken, response.refreshToken);
      storage.setItem('user', JSON.stringify(response.user));
      set({
        user: response.user,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Registration failed. Please try again.');
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  logout: () => {
    clearTokens();
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      error: null,
    });
  },

  setTokens: (access: string, refresh: string) => {
    persistTokens(access, refresh);
    set({ accessToken: access, refreshToken: refresh });
  },

  loadFromStorage: async () => {
    const accessToken = storage.getItem('accessToken');
    const refreshToken = storage.getItem('refreshToken');
    const userStr = storage.getItem('user');

    if (accessToken && refreshToken) {
      let user: User | null = null;
      if (userStr) {
        try {
          user = JSON.parse(userStr) as User;
        } catch {
          // Invalid JSON, will fetch from API
        }
      }

      set({
        accessToken,
        refreshToken,
        user,
        isAuthenticated: true,
      });

      // Validate token by fetching current user
      try {
        const freshUser = await apiGetMe();
        storage.setItem('user', JSON.stringify(freshUser));
        set({ user: freshUser });
      } catch {
        // Token is invalid, clear everything
        get().logout();
      }
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));

