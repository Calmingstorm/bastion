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
    // The boundary settles the leader at invalidation time -- attach the handler at
    // creation so the early rejection is never left dangling across macrotask gaps.
    const reqASettled = reqA.then(() => 'resolved' as const, () => 'rejected' as const);
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

    // Clean up the (already boundary-settled) refresh A promise.
    rejectRefreshA(new Error('A refresh failed'));
    expect(await reqASettled).toBe('rejected');
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
    // The boundary settles the stale leader at invalidation time -- attach r1's
    // handler at creation so its early rejection is never left dangling across the
    // macrotask gaps below (Node would report an unhandled rejection). In production
    // the caller awaits the request in a guarded try/catch immediately.
    const r1Settled = r1.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
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

  // F38 round 6 (blocker 1): the boundary itself must settle queued waiters. If the
  // stale refresh HANGS (a bare axios.post that abortInFlightRequests cannot cancel),
  // generation-scoped draining never runs -- invalidateSession() has to reject the
  // prior session's waiters directly.
  it('invalidateSession immediately rejects requests queued behind a hung refresh', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');

    let refreshStarted!: () => void;
    const refreshInFlight = new Promise<void>((r) => (refreshStarted = r));
    const postSpy = vi.spyOn(axios, 'post').mockImplementation(() => {
      refreshStarted();
      return new Promise(() => {}); // the refresh NEVER settles
    });

    apiClient.defaults.adapter = (async (config) => {
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;

    const leader = apiClient.get('/leader'); // 401 -> starts the hung refresh
    void leader.then(() => {}, () => {}); // never settles; keep it handled regardless
    await refreshInFlight;

    const queued = apiClient.get('/queued'); // 401 -> queues behind the hung refresh
    const queuedSettled = queued.then(() => 'resolved', () => 'rejected');
    await new Promise((r) => setTimeout(r, 0)); // genuinely on failedQueue

    invalidateSession(); // the boundary must drain the queue -- nothing else ever will

    const outcome = await Promise.race([
      queuedSettled,
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(outcome).toBe('rejected');
    postSpy.mockRestore();
  });

  // F38 round 7 (blocker 1): the LEADER of a hung refresh awaits the bare axios.post
  // directly -- draining the queue settles only the followers. The refresh await is
  // raced against the boundary so invalidation settles the leader too.
  it('invalidateSession settles the leader awaiting a hung refresh', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');

    let refreshStarted!: () => void;
    const refreshInFlight = new Promise<void>((r) => (refreshStarted = r));
    const postSpy = vi.spyOn(axios, 'post').mockImplementation(() => {
      refreshStarted();
      return new Promise(() => {}); // the refresh NEVER settles
    });

    apiClient.defaults.adapter = (async (config) => {
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;

    const leader = apiClient.get('/leader'); // 401 -> awaits the hung refresh
    const leaderSettled = leader.then(() => 'resolved', () => 'rejected');
    await refreshInFlight;

    invalidateSession(); // must settle the leader, not just queued followers

    const outcome = await Promise.race([
      leaderSettled,
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(outcome).toBe('rejected');
    postSpy.mockRestore();
  });

  // F38 round 6 (blocker 2): a queued request resolved by its refresh must re-check
  // its generation in the continuation. A boundary can land between the queue being
  // resolved and the waiter's .then() running -- retrying then would re-stamp the old
  // request with the NEW session's generation and bearer token.
  it('a queued request does not retry with the new session credentials when the boundary lands before its continuation', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');

    let resolveRefresh!: (v: unknown) => void;
    let refreshStarted!: () => void;
    const refreshInFlight = new Promise<void>((r) => (refreshStarted = r));
    const postSpy = vi.spyOn(axios, 'post').mockImplementation(() => {
      refreshStarted();
      return new Promise((res) => {
        resolveRefresh = res as (v: unknown) => void;
      });
    });

    // 401 on first sight of a URL, 200 on its retry; count sends per URL.
    const sends: Record<string, number> = {};
    apiClient.defaults.adapter = (async (config) => {
      const url = config.url ?? '';
      sends[url] = (sends[url] ?? 0) + 1;
      if (sends[url] > 1) {
        return { data: { url }, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
      }
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: {} };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;

    const r1 = apiClient.get('/r1'); // leader: 401 -> starts refresh (held)
    const r1Settled = r1.then(() => 'resolved', () => 'rejected');
    await refreshInFlight;

    const r2 = apiClient.get('/r2'); // queues behind the refresh
    const r2Settled = r2.then(() => 'resolved', () => 'rejected');
    await new Promise((r) => setTimeout(r, 0)); // genuinely queued

    resolveRefresh({ data: { accessToken: 'a-access-2' } });
    // Two microtasks: the refresh is awaited through a Promise.race (one hop) and
    // then the leader's continuation runs (its own generation check passes, the
    // queue is resolved with the token) -- but the waiter's .then has NOT run yet.
    await Promise.resolve();
    await Promise.resolve();
    invalidateSession(); // the boundary lands in exactly that window
    storage.setItem('accessToken', 'b-access');
    storage.setItem('refreshToken', 'b-refresh');
    await new Promise((r) => setTimeout(r, 0)); // let everything settle

    expect(await r2Settled).toBe('rejected'); // not retried across the boundary
    expect(sends['/r2']).toBe(1); // and never re-sent with the new credentials
    expect(await r1Settled).toBe('resolved'); // the leader retried inside its own (pre-boundary) turn
    postSpy.mockRestore();
  });

  // F38 round 10: a 401 from an auth endpoint is a CREDENTIAL failure, not an
  // expired session. Routing it through the refresh path (which login's teardown
  // left without a refresh token) fired the auth-failure cascade -- another logout,
  // another generation advance -- and turned "invalid credentials" into a silent
  // SessionSupersededError with no error shown to the user.
  it('an invalid login surfaces the credential error, not a silent supersession', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');
    const onFail = vi.fn();
    setAuthFailureHandler(onFail);
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(new Error('refresh must not run'));

    apiClient.defaults.adapter = (async (config) => {
      const err = new Error('Unauthorized') as Error & Record<string, unknown>;
      err.config = config;
      err.response = { status: 401, data: { error: 'invalid credentials' } };
      err.isAxiosError = true;
      throw err;
    }) as AxiosAdapter;

    await expect(useAuthStore.getState().login('a@x.com', 'wrong')).rejects.toThrow(/invalid|login failed/i);
    expect(useAuthStore.getState().error).toBeTruthy(); // the user SEES the failure
    expect(postSpy).not.toHaveBeenCalled(); // no refresh attempt for an auth 401
    expect(onFail).not.toHaveBeenCalled(); // no auth-failure cascade

    useAuthStore.setState({ user: null, isAuthenticated: false, error: null });
    postSpy.mockRestore();
  });

  // F38 round 10: the teardown-before-request order is load-bearing and must hold
  // through the REAL interceptor -- the synchronous request interceptor attaches
  // the token at creation, so if teardown ran first the login request carries no
  // stale header and storage is already clear when it goes out.
  it('login creates its request only after the previous identity is torn down', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');
    let sawAuthHeader: unknown = 'unset';
    let sawStoredToken: string | null = 'unset';
    apiClient.defaults.adapter = (async (config) => {
      sawAuthHeader = config.headers?.Authorization;
      sawStoredToken = storage.getItem('accessToken');
      return {
        data: { user: { id: 'u-b', username: 'bob' }, accessToken: 'b-access', refreshToken: 'b-refresh' },
        status: 200, statusText: 'OK', headers: {}, config,
      } as AxiosResponse;
    }) as AxiosAdapter;

    await useAuthStore.getState().login('b@x.com', 'pw');

    expect(sawAuthHeader).toBeUndefined(); // no stale token attached at creation
    expect(sawStoredToken).toBeNull(); // storage already torn down at send time
    expect(storage.getItem('accessToken')).toBe('b-access'); // new identity persisted

    useAuthStore.setState({ user: null, isAuthenticated: false, error: null });
    clearTokens();
  });

  it('register creates its request only after the previous identity is torn down', async () => {
    storage.setItem('accessToken', 'a-access');
    storage.setItem('refreshToken', 'a-refresh');
    let sawAuthHeader: unknown = 'unset';
    let sawStoredToken: string | null = 'unset';
    apiClient.defaults.adapter = (async (config) => {
      sawAuthHeader = config.headers?.Authorization;
      sawStoredToken = storage.getItem('accessToken');
      return {
        data: { user: { id: 'u-b', username: 'bob' }, accessToken: 'b-access', refreshToken: 'b-refresh' },
        status: 200, statusText: 'OK', headers: {}, config,
      } as AxiosResponse;
    }) as AxiosAdapter;

    await useAuthStore.getState().register('bob', 'b@x.com', 'pw');

    expect(sawAuthHeader).toBeUndefined();
    expect(sawStoredToken).toBeNull();
    expect(storage.getItem('accessToken')).toBe('b-access');

    useAuthStore.setState({ user: null, isAuthenticated: false, error: null });
    clearTokens();
  });
});
