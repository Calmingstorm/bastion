import type { MemberWithUser } from '../../types';

interface MentionAutocompleteProps {
  members: MemberWithUser[];
  query: string;
  selectedIndex: number;
  onSelect: (username: string) => void;
  onDismiss: () => void;
}

export function MentionAutocomplete({ members, query, selectedIndex, onSelect }: MentionAutocompleteProps) {
  const lowerQuery = query.toLowerCase();

  // Build filtered list: @bastion first, then matching members
  const entries: { username: string; displayName: string; avatarUrl?: string; isSpecial?: boolean }[] = [];

  if ('bastion'.startsWith(lowerQuery)) {
    entries.push({ username: 'bastion', displayName: 'Everyone', isSpecial: true });
  }

  for (const m of members) {
    if (m.username.toLowerCase().startsWith(lowerQuery) || (m.displayName?.toLowerCase().startsWith(lowerQuery))) {
      entries.push({
        username: m.username,
        displayName: m.displayName || m.username,
        avatarUrl: m.avatarUrl,
      });
    }
    if (entries.length >= 10) break;
  }

  if (entries.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 w-72 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] py-1 shadow-lg">
      {entries.map((entry, i) => (
        <button
          key={entry.username}
          onClick={() => onSelect(entry.username)}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-input)]'
          }`}
        >
          {entry.isSpecial ? (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">@</div>
          ) : entry.avatarUrl ? (
            <img src={entry.avatarUrl} alt={entry.displayName} className="h-6 w-6 rounded-full object-cover" />
          ) : (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white">
              {entry.displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <span className="font-medium">{entry.username}</span>
            {entry.displayName !== entry.username && !entry.isSpecial && (
              <span className={`ml-1.5 text-xs ${i === selectedIndex ? 'text-white/70' : 'text-[var(--text-muted)]'}`}>
                {entry.displayName}
              </span>
            )}
            {entry.isSpecial && (
              <span className={`ml-1.5 text-xs ${i === selectedIndex ? 'text-white/70' : 'text-[var(--text-muted)]'}`}>
                Notify all members
              </span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
