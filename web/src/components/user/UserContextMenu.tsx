import * as ContextMenu from '@radix-ui/react-context-menu';
import { apiCreateDM, apiKickMember, apiBanMember, apiTimeoutMember } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';

interface UserContextMenuProps {
  userId: string;
  username: string;
  serverId?: string;
  isOwner?: boolean;
  canModerate?: boolean;
  children: React.ReactNode;
}

export function UserContextMenu({ userId, username, serverId, isOwner, canModerate, children }: UserContextMenuProps) {
  const currentUser = useAuthStore((s) => s.user);
  const isSelf = currentUser?.id === userId;

  const handleSendMessage = async () => {
    try {
      const dm = await apiCreateDM([userId]);
      useServerStore.setState({ selectedServerId: null, selectedChannelId: null });
      useDMStore.getState().selectDM(dm.id);
    } catch { /* handled */ }
  };

  const handleCopyUsername = () => {
    navigator.clipboard.writeText(username);
  };

  const handleKick = async () => {
    if (!serverId) return;
    try { await apiKickMember(serverId, userId); } catch { /* handled */ }
  };

  const handleBan = async () => {
    if (!serverId) return;
    try { await apiBanMember(serverId, userId); } catch { /* handled */ }
  };

  const handleTimeout = async () => {
    if (!serverId) return;
    try { await apiTimeoutMember(serverId, userId, 300); } catch { /* handled */ }
  };

  const showModActions = canModerate && !isOwner && !isSelf && serverId;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-xl">
          <ContextMenu.Label className="px-2.5 py-1.5 text-xs font-bold text-[var(--text-muted)]">
            {username}
          </ContextMenu.Label>
          <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
          {!isSelf && (
            <ContextMenu.Item
              onSelect={handleSendMessage}
              className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
            >
              Send Message
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            onSelect={handleCopyUsername}
            className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white"
          >
            Copy Username
          </ContextMenu.Item>
          {showModActions && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
              <ContextMenu.Item
                onSelect={handleTimeout}
                className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white"
              >
                Timeout (5min)
              </ContextMenu.Item>
              <ContextMenu.Item
                onSelect={handleKick}
                className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white"
              >
                Kick
              </ContextMenu.Item>
              <ContextMenu.Item
                onSelect={handleBan}
                className="flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white"
              >
                Ban
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
