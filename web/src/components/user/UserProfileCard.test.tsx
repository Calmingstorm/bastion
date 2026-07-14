import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { UserProfileCard } from './UserProfileCard';
import { useAuthStore } from '../../stores/authStore';
import { invalidateSession } from '../../api/session';
import type { User } from '../../types';

// F38 round 16: the profile fetch is session+recency owned and keyed to its userId.
describe('UserProfileCard session ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a stale-session profile response is not rendered', async () => {
    const user = userEvent.setup();
    let resolveProfile!: (u: User) => void;
    vi.spyOn(client, 'apiGetUser').mockImplementation(
      () => new Promise((res) => { resolveProfile = res as (u: User) => void; })
    );
    render(
      <UserProfileCard userId="u1">
        <button>open profile</button>
      </UserProfileCard>
    );
    await user.click(screen.getByRole('button', { name: 'open profile' })); // fetch held

    await act(async () => {
      invalidateSession(); // a new account logs in while the profile is in flight
      resolveProfile({ id: 'u1', username: 'old-account-profile' } as User);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText(/old-account-profile/)).toBeNull();
  });

  it('a stale moderation completion does not close the reused card', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({ user: { id: 'me' } as User });
    vi.spyOn(client, 'apiGetUser').mockResolvedValue({ id: 'u1', username: 'target-user' } as User);
    let resolveKick!: () => void;
    vi.spyOn(client, 'apiKickMember').mockImplementation(
      () => new Promise<void>((res) => { resolveKick = () => res(); })
    );
    render(
      <UserProfileCard userId="u1" serverId="s1" canModerate>
        <button>open profile</button>
      </UserProfileCard>
    );
    await user.click(screen.getByRole('button', { name: 'open profile' }));
    await screen.findAllByText(/target-user/); // (name renders twice: title + @handle)

    await user.click(screen.getByRole('button', { name: 'Kick' })); // held

    await act(async () => {
      invalidateSession(); // a new account logs in while the kick is in flight
      resolveKick();
      await new Promise((r) => setTimeout(r, 0));
    });

    // onDone() must not run: the card (reused by the new session) stays open.
    expect(screen.getAllByText(/target-user/).length).toBeGreaterThan(0);
    useAuthStore.setState({ user: null });
  });

  it('a DM opened for a previous target is not selected and does not close the retargeted card', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({ user: { id: 'me' } as User });
    vi.spyOn(client, 'apiGetUser').mockResolvedValue({ id: 'u1', username: 'target-user' } as User);
    let resolveCreate!: (dm: unknown) => void;
    vi.spyOn(client, 'apiCreateDM').mockImplementation(
      () => new Promise((res) => { resolveCreate = res; }) as never
    );
    const { rerender } = render(
      <UserProfileCard userId="u1">
        <button>open profile</button>
      </UserProfileCard>
    );
    await user.click(screen.getByRole('button', { name: 'open profile' }));
    await screen.findAllByText(/target-user/);

    await user.click(screen.getByRole('button', { name: 'Message' })); // DM create held for u1

    rerender(
      <UserProfileCard userId="u2">
        <button>open profile</button>
      </UserProfileCard>
    ); // the card is retargeted to u2 mid-flight

    const { useDMStore } = await import('../../stores/dmStore');
    await act(async () => {
      resolveCreate({ id: 'dm-u1' }); // the u1 DM then resolves
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useDMStore.getState().selectedDMId).not.toBe('dm-u1'); // not selected
    expect(screen.getAllByText(/target-user/).length).toBeGreaterThan(0); // card not closed
    useAuthStore.setState({ user: null });
    useDMStore.getState().reset();
  });

  it('a moderation completion for a previous target does not close the retargeted card', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({ user: { id: 'me' } as User });
    vi.spyOn(client, 'apiGetUser').mockResolvedValue({ id: 'u1', username: 'target-user' } as User);
    let resolveKick!: () => void;
    vi.spyOn(client, 'apiKickMember').mockImplementation(
      () => new Promise<void>((res) => { resolveKick = () => res(); })
    );
    const { rerender } = render(
      <UserProfileCard userId="u1" serverId="server-a" canModerate>
        <button>open profile</button>
      </UserProfileCard>
    );
    await user.click(screen.getByRole('button', { name: 'open profile' }));
    await screen.findAllByText(/target-user/);

    await user.click(screen.getByRole('button', { name: 'Kick' })); // held, target (A, u1)

    rerender(
      <UserProfileCard userId="u1" serverId="server-b" canModerate>
        <button>open profile</button>
      </UserProfileCard>
    ); // the card is reused for target (B, u1)

    await act(async () => {
      resolveKick(); // the (A, u1) completion settles after retargeting
      await new Promise((r) => setTimeout(r, 0));
    });

    // onDone() must not run for the previous target: B's card stays open.
    expect(screen.getAllByText(/target-user/).length).toBeGreaterThan(0);
    useAuthStore.setState({ user: null });
  });

  it('a userId change clears the old profile, refetches, and ignores the older response', async () => {
    const user = userEvent.setup();
    let resolveFirst!: (u: User) => void;
    let resolveSecond!: (u: User) => void;
    vi.spyOn(client, 'apiGetUser')
      .mockImplementationOnce(
        () => new Promise((res) => { resolveFirst = res as (u: User) => void; })
      )
      .mockImplementationOnce(
        () => new Promise((res) => { resolveSecond = res as (u: User) => void; })
      );
    const { rerender } = render(
      <UserProfileCard userId="u1">
        <button>open profile</button>
      </UserProfileCard>
    );
    await user.click(screen.getByRole('button', { name: 'open profile' })); // u1 fetch held

    rerender(
      <UserProfileCard userId="u2">
        <button>open profile</button>
      </UserProfileCard>
    ); // userId changes while the popover stays open -> refetch for u2

    await act(async () => {
      resolveSecond({ id: 'u2', username: 'second-user' } as User); // newer commits
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      resolveFirst({ id: 'u1', username: 'first-user' } as User); // older is superseded
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getAllByText(/second-user/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/first-user/)).toBeNull();
  });
});
