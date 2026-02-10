import { useDMStore } from '../../stores/dmStore';
import { PresenceDot } from '../user/PresenceDot';

export function DMChannelHeader() {
  const { dmChannels, selectedDMId } = useDMStore();

  const dm = dmChannels.find((d) => d.id === selectedDMId);
  if (!dm) return null;

  const recipient = dm.recipients?.[0];
  const name = recipient
    ? recipient.displayName || recipient.username
    : 'Unknown';

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-[var(--border)] px-4">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mr-2 shrink-0 text-[var(--text-muted)]"
      >
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      <h3 className="font-semibold text-[var(--text-primary)]">{name}</h3>
      {recipient && (
        <PresenceDot userId={recipient.id} className="ml-2" />
      )}
    </div>
  );
}
