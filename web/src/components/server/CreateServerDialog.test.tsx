import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { CreateServerDialog } from './CreateServerDialog';
import { useServerStore } from '../../stores/serverStore';
import { invalidateSession } from '../../api/session';
import type { Server } from '../../types';

// F38 round 7: the dialog's create/join workflows are owned by the session they
// started under. A completion arriving after an identity boundary must not run the
// success UI (close/clear) or drive the new session's fetch/selection.
describe('CreateServerDialog session ownership', () => {
  const original = {
    createServer: useServerStore.getState().createServer,
    fetchServers: useServerStore.getState().fetchServers,
    selectServer: useServerStore.getState().selectServer,
  };

  beforeEach(() => {
    useServerStore.getState().reset();
  });

  afterEach(() => {
    useServerStore.setState({ ...original });
    vi.restoreAllMocks();
  });

  it('a create completing after a session change does not close or clear the dialog', async () => {
    const user = userEvent.setup();
    // Neutral store stub (resolves like a success) so this pins the DIALOG's own
    // generation check for the window after the store action settles.
    let resolveCreate!: () => void;
    useServerStore.setState({
      createServer: () =>
        new Promise<void>((res) => {
          resolveCreate = () => res();
        }),
    });
    const onOpenChange = vi.fn();

    render(<CreateServerDialog open onOpenChange={onOpenChange} />);
    const nameInput = screen.getByPlaceholderText('Enter server name');
    await user.type(nameInput, 'My Server{Enter}'); // submit; create now held

    await act(async () => {
      invalidateSession(); // a new account logs in while the create is in flight
      resolveCreate(); // the old create then "succeeds"
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false); // not treated as success
    expect((nameInput as HTMLInputElement).value).toBe('My Server'); // not cleared
  });

  it('a stale invite join does not drive the new session fetch/selection or close', async () => {
    const user = userEvent.setup();
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
    const onOpenChange = vi.fn();

    render(<CreateServerDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Join via Invite' }));
    await user.type(
      screen.getByPlaceholderText('https://example.com/invite/abc123'),
      'abc123'
    );
    await user.click(screen.getByRole('button', { name: 'Join Server' })); // join held

    await act(async () => {
      invalidateSession(); // a new account logs in while the join is in flight
      resolveJoin({ id: 'srv-old', name: 'Old', ownerId: 'u1' } as Server);
      await new Promise((r) => setTimeout(r, 0));
    });

    // The old workflow must not fetch/select in -- or close over -- the new session.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // F38 round 25: the in-app join must commit the joined server through
  // addServer() BEFORE fetching, exactly like InvitePage -- rejoining a server
  // whose leave/kick laid a tombstone must be visible immediately, not filtered
  // out of the very fetch that was supposed to reveal it.
  it('the in-app join commits the joined server before fetching (rejoin is visible)', async () => {
    const user = userEvent.setup();
    useServerStore.setState({
      servers: [{ id: 'srv-j', name: 'J', ownerId: 'u1' } as Server],
      selectedServerId: null,
    });
    useServerStore.getState().removeServer('srv-j'); // left/kicked earlier -- tombstoned
    expect(useServerStore.getState().servers).toEqual([]);
    vi.spyOn(client, 'apiJoinViaInvite').mockResolvedValue({
      id: 'srv-j', name: 'J', ownerId: 'u1',
    } as Server);
    let listAtFetch: string[] = [];
    const fetchSpy = vi.fn(async () => {
      listAtFetch = useServerStore.getState().servers.map((sv) => sv.id);
    });
    const selectSpy = vi.fn(async () => {});
    useServerStore.setState({ fetchServers: fetchSpy, selectServer: selectSpy });
    const onOpenChange = vi.fn();

    render(<CreateServerDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Join via Invite' }));
    await user.type(
      screen.getByPlaceholderText('https://example.com/invite/abc123'),
      'abc123'
    );
    await user.click(screen.getByRole('button', { name: 'Join Server' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(listAtFetch).toContain('srv-j'); // committed BEFORE the fetch ran
    expect(useServerStore.getState().servers.map((sv) => sv.id)).toContain('srv-j');
    expect(onOpenChange).toHaveBeenCalledWith(false); // success UI ran normally
  });
});
