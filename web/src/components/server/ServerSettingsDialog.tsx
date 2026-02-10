import { useState, useEffect, useRef, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  apiUpdateServer,
  apiUploadServerIcon,
  apiGetRoles,
  apiCreateRole,
  apiUpdateRole,
  apiDeleteRole,
  apiAssignRole,
  apiRemoveRole,
  apiGetBans,
  apiUnbanMember,
  apiGetAuditLog,
  apiGetMembers,
  apiKickMember,
  apiBanMember,
  apiTimeoutMember,
  apiGetChannels,
  apiCreateChannel,
  apiUpdateChannel,
  apiDeleteChannel,
  apiDeleteServer,
} from '../../api/client';
import { useServerStore } from '../../stores/serverStore';
import type { Role, ServerBan, AuditLogEntry, MemberWithUser, Channel } from '../../types';

// Permission bitfield constants — must match server/internal/permissions/permissions.go
const PERMISSIONS = {
  ViewChannel:      1 << 0,
  SendMessages:     1 << 1,
  ManageMessages:   1 << 2,
  ManageChannels:   1 << 3,
  ManageServer:     1 << 4,
  ManageRoles:      1 << 5,
  CreateInvites:    1 << 6,
  KickMembers:      1 << 7,
  BanMembers:       1 << 8,
  Administrator:    1 << 9,
  AttachFiles:      1 << 10,
  ManageCategories: 1 << 11,
  ManageNicknames:  1 << 12,
  ChangeNickname:   1 << 13,
  TimeoutMembers:   1 << 14,
} as const;

const PERMISSION_LABELS: { key: keyof typeof PERMISSIONS; label: string; desc: string }[] = [
  { key: 'ViewChannel', label: 'View Channels', desc: 'Allows viewing text channels' },
  { key: 'SendMessages', label: 'Send Messages', desc: 'Allows sending messages' },
  { key: 'AttachFiles', label: 'Attach Files', desc: 'Allows uploading files' },
  { key: 'CreateInvites', label: 'Create Invites', desc: 'Allows creating invite links' },
  { key: 'ChangeNickname', label: 'Change Nickname', desc: 'Allows changing own nickname' },
  { key: 'ManageMessages', label: 'Manage Messages', desc: "Allows deleting others' messages" },
  { key: 'ManageChannels', label: 'Manage Channels', desc: 'Create, edit, and delete channels' },
  { key: 'ManageCategories', label: 'Manage Categories', desc: 'Manage channel categories' },
  { key: 'ManageNicknames', label: 'Manage Nicknames', desc: "Change others' nicknames" },
  { key: 'ManageRoles', label: 'Manage Roles', desc: 'Create, edit, and delete roles' },
  { key: 'KickMembers', label: 'Kick Members', desc: 'Kick members from the server' },
  { key: 'BanMembers', label: 'Ban Members', desc: 'Ban members from the server' },
  { key: 'TimeoutMembers', label: 'Timeout Members', desc: 'Temporarily mute members' },
  { key: 'ManageServer', label: 'Manage Server', desc: 'Edit server name and settings' },
  { key: 'Administrator', label: 'Administrator', desc: 'Full access — bypasses all checks' },
];

type Tab = 'overview' | 'channels' | 'roles' | 'members' | 'bans' | 'audit';

interface ServerSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
}

export function ServerSettingsDialog({ open, onOpenChange, serverId }: ServerSettingsDialogProps) {
  const [tab, setTab] = useState<Tab>('overview');

  const TAB_LABELS: Record<Tab, string> = {
    overview: 'Overview',
    channels: 'Channels',
    roles: 'Roles',
    members: 'Members',
    bans: 'Bans',
    audit: 'Audit Log',
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-full max-w-5xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md bg-[var(--bg-primary)] shadow-xl">
          {/* Sidebar */}
          <div className="flex w-52 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] p-3">
            <Dialog.Title className="mb-3 px-2 text-xs font-bold uppercase tracking-wide text-[var(--text-muted)]">
              Server Settings
            </Dialog.Title>
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-2 py-1.5 text-left text-sm font-medium transition-colors ${
                  tab === t
                    ? 'bg-[var(--bg-input)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)]/50 hover:text-[var(--text-primary)]'
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-8">
            {tab === 'overview' && <OverviewTab serverId={serverId} />}
            {tab === 'channels' && <ChannelsTab serverId={serverId} />}
            {tab === 'roles' && <RolesTab serverId={serverId} />}
            {tab === 'members' && <MembersTab serverId={serverId} />}
            {tab === 'bans' && <BansTab serverId={serverId} />}
            {tab === 'audit' && <AuditTab serverId={serverId} />}
          </div>

          {/* Close */}
          <Dialog.Close asChild>
            <button className="absolute right-3 top-3 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---- Overview ---- */

function OverviewTab({ serverId }: { serverId: string }) {
  const servers = useServerStore((s) => s.servers);
  const server = servers.find((s) => s.id === serverId);
  const [name, setName] = useState(server?.name || '');
  const [description, setDescription] = useState(server?.description || '');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const currentIcon = iconPreview || server?.iconUrl;
  const serverInitial = (server?.name || '?').charAt(0).toUpperCase();

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconFile(file);
    setIconPreview(URL.createObjectURL(file));
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      // Upload icon first if changed
      if (iconFile) {
        const updated = await apiUploadServerIcon(serverId, iconFile);
        useServerStore.getState().updateServer(updated);
        setIconFile(null);
        setIconPreview(null);
      }
      const updated = await apiUpdateServer(serverId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      useServerStore.getState().updateServer(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* handled */ } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="max-w-lg space-y-4">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Server Overview</h2>

      {/* Icon upload */}
      <div className="space-y-1">
        <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Server Icon</label>
        <div
          onClick={() => iconInputRef.current?.click()}
          className="group relative h-16 w-16 cursor-pointer overflow-hidden rounded-xl"
        >
          {currentIcon ? (
            <img src={currentIcon} alt="Server icon" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[var(--accent)] text-2xl font-bold text-white">
              {serverInitial}
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </div>
        </div>
        <input ref={iconInputRef} type="file" accept="image/*" className="hidden" onChange={handleIconChange} />
        <p className="text-xs text-[var(--text-muted)]">Click to change. Max 2MB.</p>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Server Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)}
          className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--accent)]" />
      </div>
      <div className="space-y-1">
        <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1000}
          className="w-full resize-none rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          placeholder="What's this server about?" />
      </div>
      <button type="submit" disabled={isSaving || !name.trim()}
        className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
        {saved ? 'Saved!' : isSaving ? 'Saving...' : 'Save Changes'}
      </button>

      {server?.memberCount !== undefined && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{server.memberCount} member{server.memberCount !== 1 ? 's' : ''}</p>
      )}

      {/* Danger Zone */}
      <div className="mt-8 rounded-md border border-[var(--danger)]/30 p-4">
        <h3 className="text-sm font-bold text-[var(--danger)]">Danger Zone</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Deleting a server is permanent and cannot be undone. All channels, messages, and member data will be lost.
        </p>
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-[var(--text-secondary)]">
            Type <strong>{server?.name}</strong> to confirm
          </label>
          <input
            type="text"
            value={deleteConfirmName}
            onChange={(e) => setDeleteConfirmName(e.target.value)}
            placeholder="Server name"
            className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--danger)]"
          />
          {deleteError && <p className="text-xs text-[var(--danger)]">{deleteError}</p>}
          <button
            type="button"
            disabled={deleteConfirmName !== server?.name || isDeleting}
            onClick={async () => {
              setIsDeleting(true);
              setDeleteError(null);
              try {
                await apiDeleteServer(serverId);
                useServerStore.getState().removeServer(serverId);
              } catch {
                setDeleteError('Failed to delete server.');
              } finally {
                setIsDeleting(false);
              }
            }}
            className="rounded-[3px] bg-[var(--danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isDeleting ? 'Deleting...' : 'Delete Server'}
          </button>
        </div>
      </div>
    </form>
  );
}

/* ---- Channels ---- */

function ChannelsTab({ serverId }: { serverId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editTopic, setEditTopic] = useState('');
  const [newName, setNewName] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    apiGetChannels(serverId)
      .then((chs) => setChannels(chs.sort((a, b) => a.position - b.position)))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [serverId]);

  const handleCreate = async () => {
    const name = newName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    setIsCreating(true);
    try {
      const ch = await apiCreateChannel(serverId, name, newTopic.trim() || undefined);
      setChannels((prev) => [...prev, ch].sort((a, b) => a.position - b.position));
      setNewName('');
      setNewTopic('');
    } catch { /* handled */ } finally {
      setIsCreating(false);
    }
  };

  const handleSaveEdit = async (channelId: string) => {
    const name = editName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    try {
      const updated = await apiUpdateChannel(serverId, channelId, { name, topic: editTopic.trim() || undefined });
      setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      useServerStore.getState().updateChannel(updated);
    } catch { /* handled */ }
    setEditingId(null);
  };

  const handleDelete = async (channelId: string) => {
    try {
      await apiDeleteChannel(serverId, channelId);
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
      useServerStore.getState().removeChannel(channelId);
    } catch { /* handled */ }
    setDeleteConfirm(null);
  };

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Channels — {channels.length}</h2>

      <div className="space-y-1">
        {channels.map((ch) => (
          <div key={ch.id}>
            {editingId === ch.id ? (
              <div className="flex items-center gap-2 rounded bg-[var(--bg-secondary)] px-3 py-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
                  <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
                </svg>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                  className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  placeholder="Channel name" autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveEdit(ch.id); } if (e.key === 'Escape') setEditingId(null); }} />
                <input type="text" value={editTopic} onChange={(e) => setEditTopic(e.target.value)}
                  className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  placeholder="Topic (optional)"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveEdit(ch.id); } if (e.key === 'Escape') setEditingId(null); }} />
                <button onClick={() => handleSaveEdit(ch.id)}
                  className="shrink-0 rounded-[3px] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)]">Save</button>
                <button onClick={() => setEditingId(null)}
                  className="shrink-0 rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center justify-between rounded px-3 py-2 transition-colors hover:bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
                    <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />
                  </svg>
                  <span className="text-sm font-medium text-[var(--text-primary)]">{ch.name}</span>
                  {ch.topic && <span className="text-xs text-[var(--text-muted)]">— {ch.topic}</span>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => { setEditingId(ch.id); setEditName(ch.name); setEditTopic(ch.topic || ''); }}
                    className="rounded px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--text-primary)]">Edit</button>
                  {channels.length > 1 && (
                    deleteConfirm === ch.id ? (
                      <div className="flex gap-1">
                        <button onClick={() => handleDelete(ch.id)}
                          className="rounded px-2 py-1 text-xs font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10">Confirm</button>
                        <button onClick={() => setDeleteConfirm(null)}
                          className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => setDeleteConfirm(ch.id)}
                        className="rounded px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] hover:text-[var(--danger)]">Delete</button>
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create form */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="mb-3 text-sm font-bold text-[var(--text-primary)]">Create Channel</h3>
        <div className="flex gap-2">
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="channel-name"
            className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }} />
          <input type="text" value={newTopic} onChange={(e) => setNewTopic(e.target.value)}
            placeholder="Topic (optional)"
            className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }} />
          <button onClick={handleCreate} disabled={isCreating || !newName.trim()}
            className="shrink-0 rounded-[3px] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Roles ---- */

function RolesTab({ serverId }: { serverId: string }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    apiGetRoles(serverId)
      .then((r) => {
        const sorted = r.sort((a, b) => b.position - a.position);
        setRoles(sorted);
        if (sorted.length > 0) setSelectedRoleId(sorted[0].id);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [serverId]);

  const handleCreate = async () => {
    const name = newRoleName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const role = await apiCreateRole(serverId, { name });
      setRoles((prev) => [...prev, role].sort((a, b) => b.position - a.position));
      setSelectedRoleId(role.id);
      setNewRoleName('');
    } catch { /* handled */ } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (roleId: string) => {
    try {
      await apiDeleteRole(serverId, roleId);
      setRoles((prev) => prev.filter((r) => r.id !== roleId));
      if (selectedRoleId === roleId) setSelectedRoleId(roles.find((r) => r.id !== roleId)?.id || null);
    } catch { /* handled */ }
  };

  const selectedRole = roles.find((r) => r.id === selectedRoleId);

  if (isLoading) {
    return <Spinner />;
  }

  return (
    <div className="flex h-full gap-4">
      <div className="w-44 shrink-0 space-y-2">
        <h2 className="text-lg font-bold text-[var(--text-primary)]">Roles</h2>
        <div className="flex gap-1">
          <input type="text" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)}
            placeholder="New role..." onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
            className="min-w-0 flex-1 rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
          <button onClick={handleCreate} disabled={isCreating || !newRoleName.trim()}
            className="shrink-0 rounded-[3px] bg-[var(--accent)] px-2 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">+</button>
        </div>
        <div className="space-y-0.5">
          {roles.map((role) => (
            <button key={role.id} onClick={() => setSelectedRoleId(role.id)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                selectedRoleId === role.id ? 'bg-[var(--bg-input)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)]/50'
              }`}>
              <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: role.color || 'var(--text-muted)' }} />
              <span className="truncate">{role.name}</span>
            </button>
          ))}
        </div>
      </div>

      {selectedRole ? (
        <RoleEditor key={selectedRole.id} role={selectedRole} serverId={serverId}
          onUpdate={(updated) => setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)).sort((a, b) => b.position - a.position))}
          onDelete={() => handleDelete(selectedRole.id)} />
      ) : (
        <p className="py-8 text-sm text-[var(--text-muted)]">Select a role to edit.</p>
      )}
    </div>
  );
}

function RoleEditor({ role, serverId, onUpdate, onDelete }: {
  role: Role; serverId: string; onUpdate: (r: Role) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color || '#99aab5');
  const [perms, setPerms] = useState(role.permissions);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const togglePerm = (bit: number) => setPerms((p) => (p & bit ? p & ~bit : p | bit));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const updated = await apiUpdateRole(serverId, role.id, { name: name.trim(), color, permissions: perms });
      onUpdate(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* handled */ } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-w-0 flex-1 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-[var(--text-primary)]">Edit Role — {role.name}</h3>
        {!role.isDefault && (
          <button onClick={onDelete} className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10">
            Delete Role
          </button>
        )}
      </div>

      <div className="flex gap-4">
        <div className="flex-1 space-y-1">
          <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Role Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={role.isDefault}
            className="w-full rounded-[3px] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:opacity-60" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
            className="h-9 w-12 cursor-pointer rounded border border-[var(--border)] bg-transparent" />
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">Permissions</h4>
        <div className="space-y-1">
          {PERMISSION_LABELS.map(({ key, label, desc }) => {
            const bit = PERMISSIONS[key];
            const checked = (perms & bit) !== 0;
            return (
              <label key={key} className="flex items-center justify-between rounded px-3 py-2 transition-colors hover:bg-[var(--bg-secondary)]">
                <div>
                  <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
                  <p className="text-xs text-[var(--text-muted)]">{desc}</p>
                </div>
                <button type="button" role="switch" aria-checked={checked} onClick={() => togglePerm(bit)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'}`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
                </button>
              </label>
            );
          })}
        </div>
      </div>

      <button onClick={handleSave} disabled={isSaving || !name.trim()}
        className="rounded-[3px] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
        {saved ? 'Saved!' : isSaving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

/* ---- Members ---- */

function MembersTab({ serverId }: { serverId: string }) {
  const [members, setMembers] = useState<MemberWithUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<{ userId: string; type: 'kick' | 'ban' | 'timeout' | 'role' } | null>(null);
  const [reason, setReason] = useState('');
  const [timeoutMin, setTimeoutMin] = useState(60);
  const [roleToAssign, setRoleToAssign] = useState('');
  const servers = useServerStore((s) => s.servers);
  const server = servers.find((s) => s.id === serverId);

  useEffect(() => {
    Promise.all([apiGetMembers(serverId), apiGetRoles(serverId)])
      .then(([m, r]) => { setMembers(m); setRoles(r.sort((a, b) => b.position - a.position)); })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [serverId]);

  const clearAction = () => { setAction(null); setReason(''); setTimeoutMin(60); setRoleToAssign(''); };

  const refreshMembers = async () => {
    try { setMembers(await apiGetMembers(serverId)); } catch { /* handled */ }
  };

  const handleKick = async (userId: string) => {
    try { await apiKickMember(serverId, userId, reason || undefined); setMembers((p) => p.filter((m) => m.userId !== userId)); clearAction(); } catch { /* handled */ }
  };

  const handleBan = async (userId: string) => {
    try { await apiBanMember(serverId, userId, reason || undefined); setMembers((p) => p.filter((m) => m.userId !== userId)); clearAction(); } catch { /* handled */ }
  };

  const handleTimeout = async (userId: string) => {
    try { await apiTimeoutMember(serverId, userId, timeoutMin * 60, reason || undefined); clearAction(); await refreshMembers(); } catch { /* handled */ }
  };

  const handleAssignRole = async (userId: string, roleId: string) => {
    try { await apiAssignRole(serverId, roleId, userId); clearAction(); await refreshMembers(); } catch { /* handled */ }
  };

  const handleRemoveRole = async (userId: string, roleId: string) => {
    try { await apiRemoveRole(serverId, roleId, userId); await refreshMembers(); } catch { /* handled */ }
  };

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Members — {members.length}</h2>

      {/* Action panel */}
      {action && action.type !== 'role' && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <h3 className="mb-2 text-sm font-bold capitalize text-[var(--text-primary)]">{action.type} Member</h3>
          {action.type === 'timeout' && (
            <div className="mb-2">
              <label className="mb-1 block text-xs text-[var(--text-muted)]">Duration (minutes)</label>
              <input type="number" value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))} min={1} max={40320}
                className="w-32 rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
            </div>
          )}
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)"
            className="mb-3 w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-1 focus:ring-[var(--accent)]" />
          <div className="flex gap-2">
            <button onClick={() => {
              if (action.type === 'kick') handleKick(action.userId);
              else if (action.type === 'ban') handleBan(action.userId);
              else if (action.type === 'timeout') handleTimeout(action.userId);
            }} className="rounded-[3px] bg-[var(--danger)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
              Confirm {action.type}
            </button>
            <button onClick={clearAction} className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
          </div>
        </div>
      )}

      {action && action.type === 'role' && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <h3 className="mb-2 text-sm font-bold text-[var(--text-primary)]">Assign Role</h3>
          <select value={roleToAssign} onChange={(e) => setRoleToAssign(e.target.value)}
            className="mb-3 w-full rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]">
            <option value="">Select a role...</option>
            {roles.filter((r) => !r.isDefault).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div className="flex gap-2">
            <button onClick={() => { if (roleToAssign) handleAssignRole(action.userId, roleToAssign); }} disabled={!roleToAssign}
              className="rounded-[3px] bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">Assign</button>
            <button onClick={clearAction} className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {members.map((member) => {
          const displayName = member.nickname || member.displayName || member.username;
          const initial = displayName.charAt(0).toUpperCase();
          const isOwner = server?.ownerId === member.userId;
          const isTimedOut = member.timedOutUntil && new Date(member.timedOutUntil) > new Date();

          return (
            <div key={member.userId} className="flex items-center justify-between rounded px-3 py-2 transition-colors hover:bg-[var(--bg-secondary)]">
              <div className="flex items-center gap-3">
                {member.avatarUrl ? (
                  <img src={member.avatarUrl} alt={displayName} className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">{initial}</div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">{displayName}</span>
                    {isOwner && <span className="rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">OWNER</span>}
                    {isTimedOut && <span className="rounded bg-[var(--danger)]/20 px-1.5 py-0.5 text-[10px] font-bold text-[var(--danger)]">TIMED OUT</span>}
                  </div>
                  {member.roles && member.roles.length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {member.roles.map((role) => (
                        <span key={role.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: role.color || 'var(--text-muted)' }} />
                          {role.name}
                          <button onClick={() => handleRemoveRole(member.userId, role.id)} className="ml-0.5 text-[var(--text-muted)] hover:text-[var(--danger)]" title="Remove role">x</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {!isOwner && (
                <div className="flex gap-1">
                  <MemberActionBtn label="Role" onClick={() => setAction({ userId: member.userId, type: 'role' })} />
                  <MemberActionBtn label="Timeout" onClick={() => setAction({ userId: member.userId, type: 'timeout' })} />
                  <MemberActionBtn label="Kick" onClick={() => setAction({ userId: member.userId, type: 'kick' })} danger />
                  <MemberActionBtn label="Ban" onClick={() => setAction({ userId: member.userId, type: 'ban' })} danger />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MemberActionBtn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={`rounded px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-input)] ${danger ? 'hover:text-[var(--danger)]' : 'hover:text-[var(--text-primary)]'}`}>
      {label}
    </button>
  );
}

/* ---- Bans ---- */

function BansTab({ serverId }: { serverId: string }) {
  const [bans, setBans] = useState<ServerBan[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    apiGetBans(serverId).then(setBans).catch(() => {}).finally(() => setIsLoading(false));
  }, [serverId]);

  const handleUnban = async (userId: string) => {
    try { await apiUnbanMember(serverId, userId); setBans((p) => p.filter((b) => b.userId !== userId)); } catch { /* handled */ }
  };

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">Server Bans — {bans.length}</h2>
      {bans.length === 0 ? (
        <p className="py-8 text-sm text-[var(--text-muted)]">No banned members.</p>
      ) : (
        <div className="space-y-1">
          {bans.map((ban) => (
            <div key={ban.userId} className="flex items-center justify-between rounded bg-[var(--bg-secondary)] px-3 py-2">
              <div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{ban.username}</span>
                {ban.reason && <p className="text-xs text-[var(--text-muted)]">Reason: {ban.reason}</p>}
                <p className="text-xs text-[var(--text-muted)]">{new Date(ban.createdAt).toLocaleDateString()}</p>
              </div>
              <button onClick={() => handleUnban(ban.userId)}
                className="rounded-[3px] px-3 py-1.5 text-xs font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10">
                Revoke Ban
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Audit Log ---- */

function AuditTab({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterAction, setFilterAction] = useState('');

  useEffect(() => {
    setIsLoading(true);
    apiGetAuditLog(serverId, filterAction ? { action: filterAction } : undefined)
      .then(setEntries).catch(() => {}).finally(() => setIsLoading(false));
  }, [serverId, filterAction]);

  const ACTION_LABELS: Record<string, string> = {
    ROLE_CREATE: 'Created role', ROLE_UPDATE: 'Updated role', ROLE_DELETE: 'Deleted role',
    ROLE_ASSIGN: 'Assigned role', ROLE_REMOVE: 'Removed role',
    MEMBER_KICK: 'Kicked member', MEMBER_BAN: 'Banned member', MEMBER_UNBAN: 'Unbanned member', MEMBER_TIMEOUT: 'Timed out member',
    SERVER_UPDATE: 'Updated server', CHANNEL_CREATE: 'Created channel', CHANNEL_UPDATE: 'Updated channel', CHANNEL_DELETE: 'Deleted channel',
    MESSAGE_DELETE: 'Deleted message',
  };

  const actionTypes = ['', ...Object.keys(ACTION_LABELS)];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[var(--text-primary)]">Audit Log</h2>
        <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
          className="rounded-[3px] bg-[var(--bg-tertiary)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]">
          {actionTypes.map((t) => <option key={t} value={t}>{t ? (ACTION_LABELS[t] || t) : 'All Actions'}</option>)}
        </select>
      </div>

      {isLoading ? <Spinner /> : entries.length === 0 ? (
        <p className="py-8 text-sm text-[var(--text-muted)]">No audit log entries found.</p>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-3 rounded px-3 py-2 hover:bg-[var(--bg-secondary)]">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
                {(entry.actor?.displayName || entry.actor?.username || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-medium text-[var(--text-primary)]">{entry.actor?.displayName || entry.actor?.username || 'Unknown'}</span>{' '}
                  <span className="text-[var(--text-muted)]">{ACTION_LABELS[entry.actionType] || entry.actionType}</span>
                  {entry.reason && <span className="ml-1 text-[var(--text-muted)]">— {entry.reason}</span>}
                </div>
                <span className="text-xs text-[var(--text-muted)]">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Shared ---- */

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
    </div>
  );
}
