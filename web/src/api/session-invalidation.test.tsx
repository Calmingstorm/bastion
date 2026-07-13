import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosAdapter, AxiosResponse } from 'axios';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient, { clearTokens } from './client';
import { AuthFailureBridge } from '../components/AuthFailureBridge';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';

describe('session invalidation', () => {
  let originalAdapter: AxiosAdapter | undefined;

  beforeEach(() => {
    originalAdapter = apiClient.defaults.adapter as AxiosAdapter | undefined;
    clearTokens();
  });

  afterEach(() => {
    apiClient.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  // Blocker 1: the bridge must clear the auth session, not just data stores —
  // otherwise the auth store stays authenticated and /login bounces to /app.
  it('a terminal auth failure clears the auth store via the bridge', async () => {
    render(
      <MemoryRouter initialEntries={['/app']}>
        <AuthFailureBridge />
      </MemoryRouter>
    );

    apiClient.defaults.adapter = vi.fn(async (config) => {
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    });
    useAuthStore.setState({ isAuthenticated: true, user: { id: 'u1' } as never });

    // The failure handler (logout + navigate) updates React state, so run the
    // triggering request inside act to keep the test warning-free.
    await act(async () => {
      await expect(apiClient.get('/anything')).rejects.toBeTruthy();
    });

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  // Blocker 2: a request already in flight when the user logs out must be aborted
  // so it cannot resolve afterward and repopulate a freshly-reset store.
  it('logout aborts in-flight requests so they cannot repopulate a store', async () => {
    let release: (() => void) | undefined;
    let adapterRan: () => void;
    const adapterCalled = new Promise<void>((r) => {
      adapterRan = r;
    });
    apiClient.defaults.adapter = vi.fn(
      (config) =>
        new Promise<AxiosResponse>((resolve, reject) => {
          adapterRan(); // the request is now genuinely in flight (signal captured)
          config.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          release = () =>
            resolve({
              data: [{ id: 'stale-server', name: 'OldUser' }],
              status: 200,
              statusText: 'OK',
              headers: {},
              config,
            });
        })
    );

    // A server is already selected, so fetchServers takes the simple set path.
    useServerStore.setState({ servers: [], selectedServerId: 'existing' });
    const fetching = useServerStore.getState().fetchServers();
    await adapterCalled; // wait until the request is actually in flight

    // The user logs out while the request is in flight.
    useAuthStore.getState().logout();

    // Even though the response is now released, it was aborted and must not land.
    release?.();
    await fetching;

    expect(useServerStore.getState().servers).toEqual([]);
  });
});
