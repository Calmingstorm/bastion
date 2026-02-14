import type { ApplicationCommand } from '../../types';

interface SlashCommandPickerProps {
  commands: ApplicationCommand[];
  query: string;
  selectedIndex: number;
  onSelect: (cmd: ApplicationCommand) => void;
  onDismiss: () => void;
}

export function SlashCommandPicker({ commands, query, selectedIndex, onSelect }: SlashCommandPickerProps) {
  const lowerQuery = query.toLowerCase();

  const filtered = commands
    .filter((cmd) => cmd.type === 1 && cmd.name.startsWith(lowerQuery))
    .slice(0, 10);

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 w-80 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] py-1 shadow-lg">
      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
        Commands
      </div>
      {filtered.map((cmd, i) => (
        <button
          key={cmd.id}
          onClick={() => onSelect(cmd)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)]'
          }`}
        >
          <div className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent)]/20 text-xs font-bold text-[var(--accent)]">
            /
          </div>
          <div className="min-w-0 flex-1">
            <span className="font-medium">/{cmd.name}</span>
            {cmd.description && (
              <span className={`ml-2 text-xs ${i === selectedIndex ? 'text-white/70' : 'text-[var(--text-muted)]'}`}>
                {cmd.description}
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
