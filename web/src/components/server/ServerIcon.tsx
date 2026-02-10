import * as Tooltip from '@radix-ui/react-tooltip';
import type { Server } from '../../types';

interface ServerIconProps {
  server: Server;
  isSelected: boolean;
  onClick: () => void;
}

const COLORS = [
  '#5865f2',
  '#57f287',
  '#fee75c',
  '#eb459e',
  '#ed4245',
  '#3ba55d',
  '#e67e22',
  '#9b59b6',
  '#1abc9c',
  '#e91e63',
];

function getColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function ServerIcon({ server, isSelected, onClick }: ServerIconProps) {
  const initial = server.name.charAt(0).toUpperCase();
  const bgColor = getColorForId(server.id);

  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="group relative flex items-center justify-center">
            {/* Selection indicator pill */}
            <div
              className={`absolute left-0 w-1 rounded-r-full bg-white transition-all duration-200 ${
                isSelected
                  ? 'h-10'
                  : 'h-0 group-hover:h-5'
              }`}
            />

            <button
              onClick={onClick}
              className={`flex h-12 w-12 items-center justify-center text-lg font-semibold text-white transition-all duration-200 ${
                isSelected
                  ? 'rounded-2xl'
                  : 'rounded-[24px] hover:rounded-2xl'
              }`}
              style={{
                backgroundColor: server.iconUrl ? 'transparent' : bgColor,
              }}
            >
              {server.iconUrl ? (
                <img
                  src={server.iconUrl}
                  alt={server.name}
                  className={`h-12 w-12 object-cover transition-all duration-200 ${
                    isSelected ? 'rounded-2xl' : 'rounded-[24px] hover:rounded-2xl'
                  }`}
                />
              ) : (
                initial
              )}
            </button>
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            sideOffset={8}
            className="z-50 rounded-md bg-[var(--bg-tertiary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] shadow-lg"
          >
            {server.name}
            <Tooltip.Arrow className="fill-[var(--bg-tertiary)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
