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
  SessionSupersededError,
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
  /**
   * Restore and validate the stored session. Resolves true only when THIS
   * invocation owned the outcome (it was the latest, in the same session) --
   * a superseded call resolves false so startup gating waits for the owner.
   */
  loadFromStorage: () => Promise<boolean>;
  clearError: () => void;
}

// Monotonic loadFromStorage sequence: overlapping startup validations (React
// StrictMode double-effects make this operationally real) share one session
// generation, so generation checks alone cannot order them -- an OLDER validation
// failing after a newer one succeeded would log the freshly-validated session out.
// Only the LATEST invocation may commit its outcome.
let loadFromStorageSeq = 0;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  login: async (email: string, password: string) => {
    // A login attempt is a new identity boundary, and the boundary must TEAR DOWN
    // the superseded identity now -- not merely advance the generation. Without the
    // full logout teardown, the previous account's cached stores survive into the
    // new session, requests issued while this login is pending still carry the old
    // bearer token (stamped with the new generation, so their responses would
    // commit as current), and the old WebSocket stays live. logout() invalidates
    // the session FIRST, then aborts in-flight requests, clears tokens, and resets
    // every per-user store (including the socket teardown).
    get().logout();
    set({ isLoading: true, error: null });
    const generation = captureSessionGeneration();
    try {
      const response = await apiLogin(email, password);
      // Superseded by a newer boundary: reject (do NOT resolve as success, or the
      // form would navigate to /app) and do not surface a login error.
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
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
      if (err instanceof SessionSupersededError) throw err;
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
      const message = extractErrorMessage(err, 'Login failed. Please check your credentials.');
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  register: async (username: string, email: string, password: string) => {
    // Registration also establishes a new identity -- same full teardown as login.
    get().logout();
    set({ isLoading: true, error: null });
    const generation = captureSessionGeneration();
    try {
      const response = await apiRegister(username, email, password);
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
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
      if (err instanceof SessionSupersededError) throw err;
      if (!isSessionGenerationCurrent(generation)) throw new SessionSupersededError();
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
      isLoading: false, // a login that was pending when we logged out must not keep spinning
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
    // Claim recency AT ENTRY -- every invocation supersedes all earlier ones,
    // including the no-token/corrupt-token paths below. If they returned before
    // claiming, an older HELD validation would still be "latest" and commit later.
    const seq = ++loadFromStorageSeq;
    const generation = captureSessionGeneration();
    const owns = () => seq === loadFromStorageSeq && isSessionGenerationCurrent(generation);

    // loadFromStorage must be TOTAL -- startup ownership gates isInitialized, so
    // an unexpected rejection must never bypass it (App has no catch-belt: a belt
    // would let a superseded invocation's failure mount routing early).
    try {
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
        if (owns()) {
          // "No session" is an identity END for whatever provisional state exists.
          // Clearing fields is not enough: without advancing the generation, an
          // in-flight refresh started under the provisional identity could still
          // restore the old credentials afterward. logout() invalidates first,
          // then aborts transport, clears storage AND memory, disconnects the
          // socket, and resets every per-user store.
          get().logout();
          return true;
        }
        // Superseded: the owning invocation decides the outcome; commit nothing.
        return false;
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

      // Validate the token by fetching the current user. If an identity boundary
      // passes during validation, neither repopulate the user nor log out -- and
      // when two validations overlap (same generation), only the latest may commit,
      // so an older failure cannot log out the session a newer success validated.
      try {
        const freshUser = await apiGetMe();
        if (!owns()) return false;
        storage.setItem('user', JSON.stringify(freshUser));
        set({ user: freshUser });
        return true;
      } catch {
        if (!owns()) return false; // do not log out a newer session/validation
        // Token is invalid, clear everything
        get().logout();
        return true;
      }
    } catch {
      // Unexpected failure. An OWNING invocation must not complete startup with a
      // provisional identity still authenticated -- end it safely; a superseded
      // failure commits nothing and resolves false.
      if (owns()) {
        get().logout();
        return true;
      }
      return false;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));

