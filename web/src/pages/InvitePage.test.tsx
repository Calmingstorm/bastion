import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import * as client from '../api/client';
import { InvitePage } from './InvitePage';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { invalidateSession } from '../api/session';
import type { Server } from '../types';

// F38 round 7: the auto-join workflow is owned by the session it started under. A
// join resolving after an identity boundary must not run the new session's server
// fetch/selection with the old workflow's server id, nor navigate.
describe('InvitePage session ownership', () => {
  const original = {
    fetchServers: useServerStore.getState().fetchServers,
    selectServer: useServerStore.getState().selectServer,
  };

  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: true });
  });

  afterEach(() => {
    useServerStore.setState({ ...original });
    useAuthStore.setState({ isAuthenticated: false });
    vi.restoreAllMocks();
  });

  it('a stale join does not fetch/select or navigate in the new session', async () => {
    let resolveJoin!: (s: Server) => void;
    vi.spyOn(client, 'apiJoinViaInvite').mockImplementation(
      () =>
        new Promise((res) => {
          resolveJoin = res as (s: Server) => void;
        })
    );
    const fetchSpy = vi.fn(async () => {});
    const selectSpy = vi.fn(async () => {});
    useServerStore.setState({ fetchServers: fetchSpy, selectServer: selectSpy });

    render(
      <MemoryRouter initialEntries={['/invite/abc123']}>
        <Routes>
          <Route path="/invite/:code" element={<InvitePage />} />
          <Route path="/app" element={<div>APP-ROUTE</div>} />
        </Routes>
      </MemoryRouter>
    ); // effect fires the join, which is held

    await act(async () => {
      invalidateSession(); // a new account logs in while the join is in flight
      resolveJoin({ id: 'srv-old', name: 'Old', ownerId: 'u1' } as Server);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('APP-ROUTE')).toBeNull(); // did not navigate
  });
});
