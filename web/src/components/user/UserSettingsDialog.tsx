import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuthStore } from '../../stores/authStore';
import { apiUpdateProfile, apiUploadAvatar, apiChangePassword, apiChangeEmail, apiDeleteAccount, clearTokens } from '../../api/client';
import { captureSessionGeneration, isSessionGenerationCurrent } from '../../api/session';
import { useLayoutStore } from '../../stores/layoutStore';
import { useThemeStore } from '../../stores/themeStore';
import { useBreakpoints } from '../../hooks/useMediaQuery';
import { resolveMediaUrl } from '../../platform';
import { storage } from '../../utils/storage';

interface UserSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Tab = 'profile' | 'account' | 'appearance';

export function UserSettingsDialog({ open, onOpenChange }: UserSettingsDialogProps) {
  const [tab, setTab] = useState<Tab>('profile');
  const { user } = useAuthStore();
  const { isMobile } = useBreakpoints();

  if (!user) return null;

  const TAB_LABELS: Record<Tab, string> = {
    profile: 'Profile',
    account: 'Account',
    appearance: 'Appearance',
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className={`fixed z-50 overflow-hidden bg-[var(--bg-primary)] shadow-xl ${
          isMobile
            ? 'inset-0 flex flex-col'
            : 'left-1/2 top-1/2 flex h-[80vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-md'
        }`}>
          {isMobile ? (
            <>
              {/* Mobile: horizontal tab bar at top */}
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 pt-3 pb-0 safe-area-top">
                <Dialog.Title className="shrink-0 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
                  User Settings
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </Dialog.Close>
              </div>
              <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
                {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                      tab === t
                        ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {TAB_LABELS[t]}
                  </button>
                ))}
              </div>
              {/* Mobile content */}
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {tab === 'profile' && <ProfileTab onClose={() => onOpenChange(false)} />}
                {tab === 'account' && <AccountTab />}
                {tab === 'appearance' && <AppearanceTab />}
              </div>
            </>
          ) : (
            <>
              {/* Desktop: vertical sidebar */}
              <div className="flex w-44 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                <Dialog.Title className="mb-3 px-2 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
                  User Settings
                </Dialog.Title>
                {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`rounded px-2 py-1.5 text-left text-sm font-medium capitalize transition-colors ${
                      tab === t
                        ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Desktop content */}
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-8">
                {tab === 'profile' && <ProfileTab onClose={() => onOpenChange(false)} />}
                {tab === 'account' && <AccountTab />}
                {tab === 'appearance' && <AppearanceTab />}
              </div>

              {/* Close */}
              <Dialog.Close asChild>
                <button className="absolute right-3 top-3 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Dialog.Close>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProfileTab({ onClose }: { onClose: () => void }) {
  const { user } = useAuthStore();
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [aboutMe, setAboutMe] = useState(user?.aboutMe || '');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);
    // A profile save resolving after an identity boundary belongs to the PREVIOUS
    // account: it must not overwrite the new session's user (store + persistent
    // storage) or close the dialog as a success.
    const generation = captureSessionGeneration();
    try {
      const updated = await apiUpdateProfile({
        displayName: displayName.trim() || undefined,
        aboutMe: aboutMe.trim() || undefined,
      });
      if (!isSessionGenerationCurrent(generation)) return;
      useAuthStore.setState({ user: updated });
      storage.setItem('user', JSON.stringify(updated));
      onClose();
    } catch {
      if (!isSessionGenerationCurrent(generation)) return;
      setError('Failed to save profile.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setAvatarPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    // Same ownership as the profile save: a stale upload must not overwrite the
    // new session's user.
    const generation = captureSessionGeneration();
    try {
      const updated = await apiUploadAvatar(file);
      if (!isSessionGenerationCurrent(generation)) return;
      useAuthStore.setState({ user: updated });
      storage.setItem('user', JSON.stringify(updated));
    } catch {
      if (!isSessionGenerationCurrent(generation)) return;
      setError('Failed to upload avatar.');
    }
  };

  if (!user) return null;
  const initial = (user.displayName || user.username || '?').charAt(0).toUpperCase();

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Profile</h2>

      {/* Avatar */}
      <div className="flex items-center gap-4">
        <label className="group relative cursor-pointer">
          {avatarPreview || user.avatarUrl ? (
            <img src={avatarPreview || resolveMediaUrl(user.avatarUrl)!} alt="Avatar" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent)] text-xl font-bold text-white">{initial}</div>
          )}
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="text-xs font-medium text-white">Change</span>
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
        </label>
        <div>
          <p className="font-semibold text-[var(--text-primary)]">{user.username}</p>
          <p className="text-xs text-[var(--text-muted)]">Click avatar to change</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">{error}</div>
      )}

      <div className="space-y-1">
        <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Display Name</label>
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          placeholder={user.username} />
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">About Me</label>
        <textarea value={aboutMe} onChange={(e) => setAboutMe(e.target.value)} rows={3} maxLength={2000}
          className="w-full resize-none rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          placeholder="Tell us about yourself" />
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose}
          className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
          Cancel
        </button>
        <button type="submit" disabled={isSaving}
          className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </form>
  );
}

function AccountTab() {
  const { user } = useAuthStore();

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Account</h2>

      {/* Email */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="text-sm font-bold text-[var(--text-primary)]">Email</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">{user?.email}</p>
        <ChangeEmailForm />
      </div>

      {/* Password */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="text-sm font-bold text-[var(--text-primary)]">Password</h3>
        <ChangePasswordForm />
      </div>

      {/* Danger Zone */}
      <div className="rounded-md border border-[var(--danger)]/30 p-4">
        <h3 className="text-sm font-bold text-[var(--danger)]">Danger Zone</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Deleting your account is permanent and cannot be undone. Your messages will remain but show "[Deleted User]".
        </p>
        <DeleteAccountForm />
      </div>
    </div>
  );
}

function ChangeEmailForm() {
  const [show, setShow] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (!show) {
    return (
      <button onClick={() => setShow(true)}
        className="mt-2 rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        Change Email
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="New email"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Current password"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      <div className="flex gap-2">
        <button disabled={isSaving || !newEmail || !password}
          onClick={async () => {
            setIsSaving(true); setError(null);
            // A stale email change must not overwrite the new session's user.
            const generation = captureSessionGeneration();
            try {
              const updated = await apiChangeEmail(newEmail, password);
              if (!isSessionGenerationCurrent(generation)) return;
              useAuthStore.setState({ user: updated });
              storage.setItem('user', JSON.stringify(updated));
              setShow(false); setNewEmail(''); setPassword('');
            } catch {
              if (!isSessionGenerationCurrent(generation)) return;
              setError('Failed to change email. Check your password.');
            } finally { setIsSaving(false); }
          }}
          className="rounded-[3px] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {isSaving ? 'Saving...' : 'Update Email'}
        </button>
        <button onClick={() => { setShow(false); setError(null); }}
          className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </div>
  );
}

function ChangePasswordForm() {
  const [show, setShow] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  if (!show) {
    return (
      <button onClick={() => setShow(true)}
        className="mt-2 rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        Change Password
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
      <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (8+ chars)"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
      <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm new password"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {success && <p className="text-xs text-green-400">Password changed successfully!</p>}
      <div className="flex gap-2">
        <button disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
          onClick={async () => {
            if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
            if (newPassword.length < 8) { setError('New password must be at least 8 characters.'); return; }
            setIsSaving(true); setError(null);
            try {
              await apiChangePassword(currentPassword, newPassword);
              setSuccess(true); setShow(false);
              setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
              setTimeout(() => setSuccess(false), 3000);
            } catch {
              setError('Failed to change password. Check your current password.');
            } finally { setIsSaving(false); }
          }}
          className="rounded-[3px] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {isSaving ? 'Saving...' : 'Update Password'}
        </button>
        <button onClick={() => { setShow(false); setError(null); }}
          className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </div>
  );
}

function AppearanceTab() {
  const layout = useLayoutStore((s) => s.layout);
  const setLayout = useLayoutStore((s) => s.setLayout);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Appearance</h2>

      {/* Theme */}
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-[var(--text-secondary)]">Theme</h3>
        <p className="text-xs text-[var(--text-muted)]">Choose your preferred color scheme.</p>
        <div className="flex gap-3">
          <button
            onClick={() => { if (theme === 'light') toggleTheme(); }}
            className={`flex-1 rounded-md border-2 p-3 text-center text-sm font-medium transition-colors ${
              theme === 'dark'
                ? 'border-[var(--accent)] bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
            }`}
          >
            Dark
          </button>
          <button
            onClick={() => { if (theme === 'dark') toggleTheme(); }}
            className={`flex-1 rounded-md border-2 p-3 text-center text-sm font-medium transition-colors ${
              theme === 'light'
                ? 'border-[var(--accent)] bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
            }`}
          >
            Light
          </button>
        </div>
      </div>

      {/* Layout */}
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-[var(--text-secondary)]">Layout</h3>
        <p className="text-xs text-[var(--text-muted)]">Choose how the sidebar is organized.</p>
        <div className="flex gap-3">
          <button
            onClick={() => setLayout('modern')}
            className={`flex-1 rounded-md border-2 p-4 text-left transition-colors ${
              layout === 'modern'
                ? 'border-[var(--accent)] bg-[var(--bg-secondary)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--text-muted)]'
            }`}
          >
            <div className="mb-1 text-sm font-semibold text-[var(--text-primary)]">Modern</div>
            <p className="text-xs text-[var(--text-muted)]">
              Unified sidebar with DMs and servers in one panel.
            </p>
          </button>
          <button
            onClick={() => setLayout('classic')}
            className={`flex-1 rounded-md border-2 p-4 text-left transition-colors ${
              layout === 'classic'
                ? 'border-[var(--accent)] bg-[var(--bg-secondary)]'
                : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:border-[var(--text-muted)]'
            }`}
          >
            <div className="mb-1 text-sm font-semibold text-[var(--text-primary)]">Classic</div>
            <p className="text-xs text-[var(--text-muted)]">
              Separate server icons and channel list panels.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteAccountForm() {
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  if (!show) {
    return (
      <button onClick={() => setShow(true)}
        className="mt-2 rounded-[3px] bg-[var(--danger)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
        Delete Account
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <label className="block text-xs text-[var(--text-secondary)]">
        Type <strong>DELETE</strong> to confirm
      </label>
      <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--danger)]" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password"
        className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--danger)]" />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      <div className="flex gap-2">
        <button disabled={isDeleting || confirmText !== 'DELETE' || !password}
          onClick={async () => {
            setIsDeleting(true); setError(null);
            try {
              await apiDeleteAccount(password);
              clearTokens();
              window.location.href = '/login'; // Delete account — hard redirect is intentional
            } catch {
              setError('Failed to delete account. Check your password or ensure you don\'t own any servers.');
            } finally { setIsDeleting(false); }
          }}
          className="rounded-[3px] bg-[var(--danger)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
          {isDeleting ? 'Deleting...' : 'Permanently Delete Account'}
        </button>
        <button onClick={() => { setShow(false); setError(null); }}
          className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </div>
  );
}
