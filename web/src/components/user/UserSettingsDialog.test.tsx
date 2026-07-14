import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as client from '../../api/client';
import { UserSettingsDialog } from './UserSettingsDialog';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
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
    // The finally is owned too: a stale settlement must not flip the old form back
    // to ready (the button stays in its in-flight state).
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy();
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

  // F38 round 9: the FileReader preview callback is an async boundary too -- a read
  // started under account A must not publish A's avatar preview into B's UI.
  it('an avatar preview read across a session change is not published', async () => {
    vi.spyOn(client, 'apiUploadAvatar').mockImplementation(() => new Promise(() => {}));

    const { container } = render(<UserSettingsDialog open onOpenChange={vi.fn()} />);
    const fileInput = container.ownerDocument.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    // fireEvent dispatches synchronously: the handler starts the FileReader read and
    // returns, and the boundary lands BEFORE the async onload can fire. (user.upload
    // awaits internal act cycles, which would let the read complete first.)
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
    });
    invalidateSession(); // boundary before the FileReader completes

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20)); // let the read finish
    });

    const preview = container.ownerDocument.querySelector('img[src^="data:"]');
    expect(preview).toBeNull(); // A's preview never rendered into B's UI
  });

  // F38 round 9: a deletion held under account A resolving after account B logged in
  // deleted A's account -- it must not end B's session (clear tokens / redirect).
  it('an account deletion resolving after a session change does not end the new session', async () => {
    const user = userEvent.setup();
    let resolveDelete!: () => void;
    vi.spyOn(client, 'apiDeleteAccount').mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveDelete = () => res();
        })
    );
    const clearSpy = vi.spyOn(client, 'clearTokens');

    render(<UserSettingsDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'account' }));
    await user.click(screen.getByRole('button', { name: 'Delete Account' }));
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.type(screen.getByPlaceholderText('Your password'), 'password1');
    await user.click(screen.getByRole('button', { name: 'Permanently Delete Account' })); // held

    await act(async () => {
      boundaryToUserB();
      resolveDelete();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(clearSpy).not.toHaveBeenCalled(); // B's credentials untouched
    expect(storage.getItem('user')).toBe(JSON.stringify(userB));
  });

  // F38 round 10: a SUCCESSFUL deletion must perform the full identity transition
  // (the account no longer exists) -- not just clear tokens and hope the redirect
  // reloads. The deleted user must not remain authenticated with cached data.
  it('a current-session account deletion performs the full identity transition', async () => {
    const user = userEvent.setup();
    vi.spyOn(client, 'apiDeleteAccount').mockResolvedValue(undefined);
    useAuthStore.setState({ isAuthenticated: true });
    useServerStore.setState({ servers: [{ id: 's1', name: 'S', ownerId: 'u-a' }] as never });

    render(<UserSettingsDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'account' }));
    await user.click(screen.getByRole('button', { name: 'Delete Account' }));
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.type(screen.getByPlaceholderText('Your password'), 'password1');
    await user.click(screen.getByRole('button', { name: 'Permanently Delete Account' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useAuthStore.getState().isAuthenticated).toBe(false); // identity ended
    expect(useAuthStore.getState().user).toBeNull();
    expect(useServerStore.getState().servers).toEqual([]); // per-user stores reset
  });

  // F38 round 9: the password change owns its whole workflow, including the delayed
  // success-dismiss timer -- a change held under A must not surface success in B's UI.
  it('a password change resolving after a session change surfaces no success UI', async () => {
    const user = userEvent.setup();
    let resolveChange!: () => void;
    vi.spyOn(client, 'apiChangePassword').mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveChange = () => res();
        })
    );

    render(<UserSettingsDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'account' }));
    await user.click(screen.getByRole('button', { name: 'Change Password' }));
    await user.type(screen.getByPlaceholderText('Current password'), 'oldpass99');
    await user.type(screen.getByPlaceholderText('New password (8+ chars)'), 'newpass99');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpass99');
    await user.click(screen.getByRole('button', { name: 'Update Password' })); // held

    await act(async () => {
      boundaryToUserB();
      resolveChange();
      await new Promise((r) => setTimeout(r, 0));
    });

    // The stale completion must not run the success UI: no success message, and the
    // form must NOT collapse back to the "Change Password" button (setShow(false)
    // is the success behavior).
    expect(screen.queryByText('Password changed successfully!')).toBeNull();
    expect(screen.getByPlaceholderText('New password (8+ chars)')).toBeTruthy();
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
    // The finally is owned too: the stale form must not flip back to ready.
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy();
  });
});
