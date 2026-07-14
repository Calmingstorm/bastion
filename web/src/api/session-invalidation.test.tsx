import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios, { type AxiosAdapter, type AxiosResponse } from 'axios';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient, { clearTokens, setAuthFailureHandler } from './client';
import { invalidateSession, captureSessionGeneration } from './session';
import { storage } from '../utils/storage';
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

  // F38: a token refresh that was started for account A and rejects with 401 AFTER
  // account B has logged in must not clear B's tokens or trigger auth failure.
  it('a stale refresh rejection does not clear the new session tokens', async () => {
    storage.setItem('accessToken', 'new-access');
    storage.setItem('refreshToken', 'new-refresh');
    const onFail = vi.fn();
    setAuthFailureHandler(onFail);

    // The triggering request 401s, so the interceptor enters the refresh path.
    apiClient.defaults.adapter = vi.fn(async (config) => {
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    });

    // Hold the bare-axios refresh call; signal when it is actually invoked so we can
    // advance the session while it is genuinely in flight.
    let rejectRefresh!: (e: unknown) => void;
    let refreshInvoked!: () => void;
    const refreshCalled = new Promise<void>((r) => {
      refreshInvoked = r;
    });
    const postSpy = vi.spyOn(axios, 'post').mockImplementation(() => {
      refreshInvoked();
      return new Promise((_res, rej) => {
        rejectRefresh = rej;
      });
    });

    const req = apiClient.get('/x');
    await refreshCalled; // refresh in flight -> generation captured

    invalidateSession(); // a newer account logs in during the refresh

    const rerr = new Error('refresh rejected') as Error & Record<string, unknown>;
    rerr.response = { status: 401, data: {} };
    rerr.isAxiosError = true;
    await act(async () => {
      rejectRefresh(rerr);
      await expect(req).rejects.toBeTruthy();
    });

    // The stale 401 must not have ended the new session.
    expect(storage.getItem('accessToken')).toBe('new-access');
    expect(onFail).not.toHaveBeenCalled();
    postSpy.mockRestore();
  });

  // F38 round 3: a request issued under an ended session that 401s must NOT trigger a
  // refresh/retry -- that would reuse the new account's credentials for the old request.
  it('a stale request that 401s after the session ended is not refreshed or retried', async () => {
    storage.setItem('accessToken', 'tok');
    storage.setItem('refreshToken', 'ref');
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(new Error('should not refresh'));

    let release401!: () => void;
    let adapterRan!: () => void;
    const adapterCalled = new Promise<void>((r) => {
      adapterRan = r;
    });
    apiClient.defaults.adapter = ((config) =>
      new Promise<AxiosResponse>((_res, reject) => {
          adapterRan();
          release401 = () => {
            const err = new Error('Unauthorized') as Error & Record<string, unknown>;
            err.config = config;
            err.response = { status: 401, data: {} };
            err.isAxiosError = true;
            reject(err);
          };
        })) as AxiosAdapter;

    const req = apiClient.get('/x'); // tagged with the current generation at send time
    await adapterCalled;
    invalidateSession(); // the session ends while the request is in flight
    release401(); // now its 401 comes back
    await expect(req).rejects.toBeTruthy();

    expect(postSpy).not.toHaveBeenCalled(); // stale request must not have refreshed
    postSpy.mockRestore();
  });

  // F38 round 3: a current-session request must not queue behind a refresh that
  // belongs to an ended session and inherit its rejection; it starts its own.
  it('a current-session request does not inherit a stale in-flight refresh rejection', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');

    // First refresh (account A) is held; a later one (account B) succeeds.
    let rejectRefreshA!: (e: unknown) => void;
    let refreshACalled!: () => void;
    const refreshAInFlight = new Promise<void>((r) => {
      refreshACalled = r;
    });
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockImplementationOnce(
        () =>
          new Promise((_res, rej) => {
            refreshACalled();
            rejectRefreshA = rej;
          })
      )
      .mockResolvedValueOnce({ data: { accessToken: 'b-access' } } as never);

    // The adapter 401s the first time /b is seen, then succeeds on its retry.
    const seen = new Set<string>();
    const adapter = (async (config): Promise<AxiosResponse> => {
      if (config.url === '/b' && seen.has('b')) {
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
      }
      if (config.url === '/b') seen.add('b');
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;
    apiClient.defaults.adapter = adapter;

    const reqA = apiClient.get('/a'); // account A: 401 -> starts refresh A (held)
    await refreshAInFlight;

    invalidateSession(); // account B logs in
    storage.setItem('accessToken', 'b-access');
    storage.setItem('refreshToken', 'b-refresh');

    // Account B's request 401s: it must reset the stale refresh A and start its own.
    let reqB: AxiosResponse | undefined;
    await act(async () => {
      reqB = await apiClient.get('/b');
    });
    expect((reqB?.data as { ok: boolean }).ok).toBe(true); // B succeeded on its own refresh

    // Clean up the still-held refresh A.
    rejectRefreshA(new Error('A refresh failed'));
    await expect(reqA).rejects.toBeTruthy();
    postSpy.mockRestore();
  });

  // F38 round 4: the request interceptor must run synchronously, so a request
  // created just before an identity boundary is stamped with the OLD generation
  // (not the new one a microtask-later interceptor would capture).
  it('stamps a request with the generation at creation time, not a microtask later', async () => {
    const g = captureSessionGeneration();
    let stampedGen: number | undefined;
    apiClient.defaults.adapter = (async (config) => {
      stampedGen = (config as { __sessionGeneration?: number }).__sessionGeneration;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
    }) as AxiosAdapter;

    const req = apiClient.get('/x'); // synchronous interceptor stamps here...
    invalidateSession(); // ...before this boundary can advance the generation
    await req;

    expect(stampedGen).toBe(g); // stamped with the pre-boundary generation
  });

  // F38 round 4: after a newer refresh (B) supersedes a held refresh (A), A's late
  // settlement must not drain the queue that now belongs to B.
  it('a stale refresh settling does not drain the current refresh queue', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');

    let rejectA!: (e: unknown) => void;
    let resolveB!: (v: unknown) => void;
    let aStarted!: () => void;
    let bStarted!: () => void;
    const aInFlight = new Promise<void>((r) => (aStarted = r));
    const bInFlight = new Promise<void>((r) => (bStarted = r));
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockImplementationOnce(
        () =>
          new Promise((_res, rej) => {
            aStarted();
            rejectA = rej;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            bStarted();
            resolveB = res as (v: unknown) => void;
          })
      );

    const retried = new Set<string>();
    apiClient.defaults.adapter = (async (config) => {
      const url = config.url ?? '';
      if (retried.has(url)) {
        return { data: { url }, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
      }
      retried.add(url);
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;

    const r1 = apiClient.get('/r1'); // 401 -> starts refresh A (held)
    await aInFlight;

    invalidateSession(); // account B logs in -> A is now stale
    storage.setItem('accessToken', 'b-access');
    storage.setItem('refreshToken', 'b-refresh');

    const rb = apiClient.get('/rb'); // 401 -> resets stale A, starts refresh B (held)
    await bInFlight;

    const r3 = apiClient.get('/r3'); // 401 -> queues behind refresh B
    // A macrotask flush so r3 has genuinely 401'd and been pushed onto failedQueue
    // (the adapter is async; microtask flushes are not enough) before A settles.
    await new Promise((r) => setTimeout(r, 0));

    // r1 (account A's original request) rejects when A fails, but it is not awaited
    // until the end of the test -- and the macrotask gaps below would otherwise leave
    // it momentarily rejected-with-no-handler, which Node reports as an unhandled
    // rejection (failing the run even though every assertion passes). Attach its
    // handler synchronously here. In production the caller awaits the request in a
    // guarded try/catch immediately, so this window never exists.
    const r1Settled = r1.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );

    // A settles late: with the guard it must NOT reject r3 (which waits on B).
    rejectA(new Error('A failed'));
    await new Promise((r) => setTimeout(r, 0));

    // B succeeds -> drains its own queue -> r3 retries and succeeds.
    resolveB({ data: { accessToken: 'b-access-2' } });
    const r3res = await r3;
    expect((r3res as { data: { url: string } }).data.url).toBe('/r3'); // not drained by A

    expect(await r1Settled).toBe('rejected'); // r1 (account A) genuinely failed
    await rb;
    postSpy.mockRestore();
  });

  // F38 round 5 (blocker 1): a request queued behind a refresh that then goes stale and
  // rejects must itself reject -- not hang forever. Even with NO replacement refresh to
  // reset the queue, the stale refresh must drain ITS OWN generation's waiters.
  it('rejects an old-session request queued behind a refresh that goes stale', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');

    let rejectRefresh!: (e: unknown) => void;
    let refreshStarted!: () => void;
    const refreshInFlight = new Promise<void>((r) => (refreshStarted = r));
    const postSpy = vi.spyOn(axios, 'post').mockImplementation(
      () =>
        new Promise((_res, rej) => {
          refreshStarted();
          rejectRefresh = rej;
        })
    );

    // Every request 401s; the refresh never succeeds (held, then rejected).
    apiClient.defaults.adapter = (async (config) => {
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;

    const leader = apiClient.get('/leader'); // 401 -> starts refresh A (held)
    const leaderSettled = leader.then(() => 'resolved', () => 'rejected');
    await refreshInFlight;

    const queued = apiClient.get('/queued'); // 401 -> queues behind refresh A
    const queuedSettled = queued.then(() => 'resolved', () => 'rejected');
    // Let the queued request genuinely 401 and land on failedQueue (async adapter).
    await new Promise((r) => setTimeout(r, 0));

    invalidateSession(); // session ends; refresh A is now stale, no replacement starts
    rejectRefresh(new Error('refresh failed'));

    // The queued request must settle (reject), not hang past the timeout.
    const outcome = await Promise.race([
      queuedSettled,
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(outcome).toBe('rejected');
    expect(await leaderSettled).toBe('rejected');
    postSpy.mockRestore();
  });
});
