import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { UserProfileCard } from './UserProfileCard';
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
