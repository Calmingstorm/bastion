import { create } from 'zustand';
import type { User } from '../types';
import {
  apiLogin,
  apiRegister,
  apiGetMe,
  setTokens as persistTokens,
  clearTokens,
  abortInFlightRequests,
} from '../api/client';
import {
  invalidateSession,
  captureSessionGeneration,
  isSessionGenerationCurrent,
} from '../api/session';
import { extractErrorMessage } from '../utils/errors';
import { storage } from '../utils/storage';
import { resetAllStores } from './resetAll';

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
    // A login attempt is a new identity boundary: advance the generation now so it
    // supersedes any older in-flight auth op or session work, and capture it to
    // detect a newer boundary (a concurrent login, or a logout) during the request.
    invalidateSession();
    const generation = captureSessionGeneration();
    try {
      const response = await apiLogin(email, password);
      if (!isSessionGenerationCurrent(generation)) return; // superseded -> do not resurrect
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
      if (!isSessionGenerationCurrent(generation)) return; // superseded
      const message = extractErrorMessage(err, 'Login failed. Please check your credentials.');
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  register: async (username: string, email: string, password: string) => {
    set({ isLoading: true, error: null });
    // Registration also establishes a new identity -- same boundary as login.
    invalidateSession();
    const generation = captureSessionGeneration();
    try {
      const response = await apiRegister(username, email, password);
      if (!isSessionGenerationCurrent(generation)) return; // superseded -> do not resurrect
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
      if (!isSessionGenerationCurrent(generation)) return; // superseded
      const message = extractErrorMessage(err, 'Registration failed. Please try again.');
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  logout: () => {
    // Advance the session generation FIRST -- before aborting requests or
    // resetting stores -- so any async work already in flight (even one that
    // resolves during this teardown) sees a stale generation and refuses to write
    // into the next session. Aborting transport below is best-effort on top of it.
    invalidateSession();
    abortInFlightRequests();
    clearTokens();
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      error: null,
    });
    // Clear every other per-user store so the next user on this session does not
    // inherit the previous user's cached data.
    resetAllStores();
  },

  setTokens: (access: string, refresh: string) => {
    persistTokens(access, refresh);
    set({ accessToken: access, refreshToken: refresh });
  },

  loadFromStorage: async () => {
    const accessToken = storage.getItem('accessToken');
    const refreshToken = storage.getItem('refreshToken');
    const userStr = storage.getItem('user');

    // Reject obviously invalid tokens (e.g. literal "undefined", empty, HTML pages)
    const isValidToken = (t: string | null): boolean => {
      if (!t || t.length < 10) return false;
      if (t === 'undefined' || t === 'null') return false;
      if (t.startsWith('<') || t.startsWith('{')) return false;
      return true;
    };

    if (!isValidToken(accessToken) || !isValidToken(refreshToken)) {
      // Corrupted tokens — clear and bail
      clearTokens();
      return;
    }

    let user: User | null = null;
    if (userStr) {
      try {
        const parsed = JSON.parse(userStr);
        // Validate the parsed user has required fields
        if (parsed && typeof parsed === 'object' && parsed.id && parsed.username) {
          user = parsed as User;
        }
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
  },

  clearError: () => {
    set({ error: null });
  },
}));

