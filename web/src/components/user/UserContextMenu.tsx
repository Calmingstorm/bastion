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

  const handleTimeout = async (duration: number) => {
    if (!serverId) return;
    try { await apiTimeoutMember(serverId, userId, duration); } catch { /* handled */ }
  };

  const showModActions = canModerate && !isOwner && !isSelf && serverId;

  const itemClass = "flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-white";
  const dangerClass = "flex w-full cursor-default items-center rounded px-2.5 py-1.5 text-sm outline-none text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white";

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
            <ContextMenu.Item onSelect={handleSendMessage} className={itemClass}>
              Send Message
            </ContextMenu.Item>
          )}
          <ContextMenu.Item onSelect={handleCopyUsername} className={itemClass}>
            Copy Username
          </ContextMenu.Item>
          {showModActions && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className={dangerClass}>
                  Timeout
                  <span className="ml-auto text-xs">&#9656;</span>
                </ContextMenu.SubTrigger>
                <ContextMenu.SubContent className="z-50 min-w-[140px] rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-xl">
                  {[
                    { label: '1 minute', seconds: 60 },
                    { label: '5 minutes', seconds: 300 },
                    { label: '10 minutes', seconds: 600 },
                    { label: '1 hour', seconds: 3600 },
                    { label: '1 day', seconds: 86400 },
                    { label: '1 week', seconds: 604800 },
                  ].map((opt) => (
                    <ContextMenu.Item
                      key={opt.seconds}
                      onSelect={() => handleTimeout(opt.seconds)}
                      className={dangerClass}
                    >
                      {opt.label}
                    </ContextMenu.Item>
                  ))}
                  <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                  <ContextMenu.Item
                    onSelect={() => handleTimeout(0)}
                    className={itemClass}
                  >
                    Remove Timeout
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Sub>
              <ContextMenu.Item onSelect={handleKick} className={dangerClass}>
                Kick
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={handleBan} className={dangerClass}>
                Ban
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
