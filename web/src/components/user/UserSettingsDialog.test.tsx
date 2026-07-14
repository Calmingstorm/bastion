import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { UserSettingsDialog } from './UserSettingsDialog';
import { useAuthStore } from '../../stores/authStore';
import { invalidateSession } from '../../api/session';
import { storage } from '../../utils/storage';
import type { User } from '../../types';

// F38 round 8: user-account mutations (profile save, avatar upload, email change)
// write to authStore AND persistent storage. One held under account A and resolving
// after account B logged in must not overwrite B's user or close the dialog.
const userA = { id: 'u-a', username: 'alice', displayName: 'Alice' } as User;
const userB = { id: 'u-b', username: 'bob', displayName: 'Bob' } as User;
const updatedA = { id: 'u-a', username: 'alice', displayName: 'Alice Updated' } as User;

function boundaryToUserB() {
  invalidateSession(); // account B logs in
  useAuthStore.setState({ user: userB });
  storage.setItem('user', JSON.stringify(userB));
}

describe('UserSettingsDialog session ownership', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: userA });
    storage.setItem('user', JSON.stringify(userA));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
    storage.removeItem('user');
    vi.restoreAllMocks();
  });

  it('a profile save resolving after a session change does not overwrite the new user or close', async () => {
    const user = userEvent.setup();
    let resolveSave!: (u: User) => void;
    vi.spyOn(client, 'apiUpdateProfile').mockImplementation(
      () =>
        new Promise((res) => {
          resolveSave = res as (u: User) => void;
        })
    );
    const onOpenChange = vi.fn();

    render(<UserSettingsDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Save Changes' })); // held

    await act(async () => {
      boundaryToUserB();
      resolveSave(updatedA); // the old save then completes
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useAuthStore.getState().user).toEqual(userB); // B not overwritten
    expect(storage.getItem('user')).toBe(JSON.stringify(userB)); // storage intact
    expect(onOpenChange).not.toHaveBeenCalledWith(false); // not closed as success
  });

  it('an avatar upload resolving after a session change does not overwrite the new user', async () => {
    const user = userEvent.setup();
    let resolveUpload!: (u: User) => void;
    vi.spyOn(client, 'apiUploadAvatar').mockImplementation(
      () =>
        new Promise((res) => {
          resolveUpload = res as (u: User) => void;
        })
    );

    const { container } = render(<UserSettingsDialog open onOpenChange={vi.fn()} />);
    const fileInput = container.ownerDocument.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    await user.upload(fileInput, new File(['x'], 'a.png', { type: 'image/png' })); // held

    await act(async () => {
      boundaryToUserB();
      resolveUpload(updatedA);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useAuthStore.getState().user).toEqual(userB);
    expect(storage.getItem('user')).toBe(JSON.stringify(userB));
  });

  it('an email change resolving after a session change does not overwrite the new user', async () => {
    const user = userEvent.setup();
    let resolveChange!: (u: User) => void;
    vi.spyOn(client, 'apiChangeEmail').mockImplementation(
      () =>
        new Promise((res) => {
          resolveChange = res as (u: User) => void;
        })
    );

    render(<UserSettingsDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'account' })); // desktop tab
    await user.click(screen.getByRole('button', { name: 'Change Email' }));
    await user.type(screen.getByPlaceholderText('New email'), 'new@example.com');
    await user.type(screen.getByPlaceholderText('Current password'), 'password1');
    await user.click(screen.getByRole('button', { name: 'Update Email' })); // held

    await act(async () => {
      boundaryToUserB();
      resolveChange(updatedA);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useAuthStore.getState().user).toEqual(userB);
    expect(storage.getItem('user')).toBe(JSON.stringify(userB));
  });
});
