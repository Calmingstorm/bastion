import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { ServerIcon } from './ServerIcon';
import { CreateServerDialog } from './CreateServerDialog';
import bastionLogo from '../../assets/bastion-logo.svg';

export function ServerList() {
  // Targeted selectors to avoid cascading re-renders
  const servers = useServerStore((s) => s.servers);
  const selectedServerId = useServerStore((s) => s.selectedServerId);
  const selectServer = useServerStore((s) => s.selectServer);
  const selectDM = useDMStore((s) => s.selectDM);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleHomeClick = () => {
    // Deselect server to show DM view -- through the store action, which claims
    // the channel lineage so a held selectServer cannot install its channels
    // (and shadow the DM view) after we entered empty scope.
    useServerStore.getState().clearServerSelection();
    selectDM(null);
  };

  const handleServerClick = (id: string) => {
    selectDM(null); // clear DM selection
    selectServer(id);
  };

  return (
    <div className="flex h-full w-[72px] flex-col items-center gap-2 overflow-y-auto bg-[var(--bg-tertiary)] py-3">
      {/* Home button / brand */}
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              onClick={handleHomeClick}
              className={`mb-1 flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-200 ${
                !selectedServerId
                  ? 'bg-[var(--accent)]'
                  : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
              }`}
            >
              <img src={bastionLogo} alt="Bastion" className="h-8 w-8" />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="right"
              sideOffset={8}
              className="z-50 rounded-md bg-[var(--bg-tertiary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] shadow-lg"
            >
              Direct Messages
              <Tooltip.Arrow className="fill-[var(--bg-tertiary)]" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>

      {/* Separator */}
      <div className="mx-auto h-[2px] w-8 rounded-full bg-[var(--border)]" />

      {/* Server list */}
      {servers.map((server) => (
        <ServerIcon
          key={server.id}
          server={server}
          isSelected={server.id === selectedServerId}
          onClick={() => handleServerClick(server.id)}
        />
      ))}

      {/* Separator */}
      <div className="mx-auto h-[2px] w-8 rounded-full bg-[var(--border)]" />

      {/* Add server button */}
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              onClick={() => setDialogOpen(true)}
              className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--bg-secondary)] text-[var(--success)] transition-all duration-200 hover:bg-[var(--success)] hover:text-white"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6V5z" />
              </svg>
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="right"
              sideOffset={8}
              className="z-50 rounded-md bg-[var(--bg-tertiary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] shadow-lg"
            >
              Add a Server
              <Tooltip.Arrow className="fill-[var(--bg-tertiary)]" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>

      <CreateServerDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
