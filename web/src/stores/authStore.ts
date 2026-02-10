import { create } from 'zustand';
import type { User } from '../types';
import {
  apiLogin,
  apiRegister,
  apiGetMe,
  setTokens as persistTokens,
  clearTokens,
} from '../api/client';

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
      localStorage.setItem('user', JSON.stringify(response.user));
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
      localStorage.setItem('user', JSON.stringify(response.user));
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
    const accessToken = localStorage.getItem('accessToken');
    const refreshToken = localStorage.getItem('refreshToken');
    const userStr = localStorage.getItem('user');

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
        localStorage.setItem('user', JSON.stringify(freshUser));
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

function extractErrorMessage(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === 'object' &&
    'response' in err
  ) {
    const axiosErr = err as { response?: { data?: { message?: string; error?: string } } };
    if (axiosErr.response?.data?.message) {
      return axiosErr.response.data.message;
    }
    if (axiosErr.response?.data?.error) {
      return axiosErr.response.data.error;
    }
  }
  return fallback;
}
