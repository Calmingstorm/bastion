import { useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useServerStore } from '../../stores/serverStore';
import { ServerIcon } from './ServerIcon';
import { CreateServerDialog } from './CreateServerDialog';

export function ServerList() {
  const { servers, selectedServerId, selectServer } = useServerStore();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex h-full w-[72px] flex-col items-center gap-2 overflow-y-auto bg-[var(--bg-tertiary)] py-3">
      {/* Home button / brand */}
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white transition-all duration-200 hover:rounded-xl hover:bg-[var(--accent-hover)]">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M3 9.5L12 4l9 5.5v9L12 24l-9-5.5v-9zM12 2L1 8.5v9L12 24l11-6.5v-9L12 2z" />
                <path d="M12 8a4 4 0 100 8 4 4 0 000-8z" />
              </svg>
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="right"
              sideOffset={8}
              className="z-50 rounded-md bg-[var(--bg-tertiary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] shadow-lg"
            >
              Bastion
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
          onClick={() => selectServer(server.id)}
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
              className="flex h-12 w-12 items-center justify-center rounded-[24px] bg-[var(--bg-secondary)] text-[var(--success)] transition-all duration-200 hover:rounded-2xl hover:bg-[var(--success)] hover:text-white"
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
