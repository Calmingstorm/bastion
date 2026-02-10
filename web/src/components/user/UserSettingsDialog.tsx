import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuthStore } from '../../stores/authStore';
import { apiUpdateProfile, apiUploadAvatar } from '../../api/client';

interface UserSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UserSettingsDialog({ open, onOpenChange }: UserSettingsDialogProps) {
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
    try {
      const updated = await apiUpdateProfile({
        displayName: displayName.trim() || undefined,
        aboutMe: aboutMe.trim() || undefined,
      });
      // Update user in auth store
      useAuthStore.setState({ user: updated });
      localStorage.setItem('user', JSON.stringify(updated));
      onOpenChange(false);
    } catch {
      setError('Failed to save profile.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Preview
    const reader = new FileReader();
    reader.onload = (ev) => setAvatarPreview(ev.target?.result as string);
    reader.readAsDataURL(file);

    try {
      const updated = await apiUploadAvatar(file);
      useAuthStore.setState({ user: updated });
      localStorage.setItem('user', JSON.stringify(updated));
    } catch {
      setError('Failed to upload avatar.');
    }
  };

  if (!user) return null;

  const initial = (user.displayName || user.username).charAt(0).toUpperCase();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md bg-[var(--bg-primary)] p-6 shadow-xl">
          <Dialog.Title className="text-xl font-bold text-[var(--text-primary)]">
            User Settings
          </Dialog.Title>

          {/* Avatar */}
          <div className="mt-4 flex items-center gap-4">
            <label className="group relative cursor-pointer">
              {avatarPreview || user.avatarUrl ? (
                <img
                  src={avatarPreview || user.avatarUrl!}
                  alt="Avatar"
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--accent)] text-xl font-bold text-white">
                  {initial}
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="text-xs font-medium text-white">Change</span>
              </div>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </label>
            <div>
              <p className="font-semibold text-[var(--text-primary)]">{user.username}</p>
              <p className="text-xs text-[var(--text-muted)]">Click avatar to change</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            {error && (
              <div className="rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
                {error}
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder={user.username}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                About Me
              </label>
              <textarea
                value={aboutMe}
                onChange={(e) => setAboutMe(e.target.value)}
                rows={3}
                maxLength={2000}
                className="w-full resize-none rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder="Tell us about yourself"
              />
            </div>

            <div className="flex justify-end gap-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={isSaving}
                className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
