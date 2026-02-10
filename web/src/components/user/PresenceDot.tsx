import { usePresenceStore } from '../../stores/presenceStore';

interface PresenceDotProps {
  userId: string;
  className?: string;
}

const statusColors: Record<string, string> = {
  online: 'bg-[var(--success)]',
  idle: 'bg-yellow-500',
  dnd: 'bg-[var(--danger)]',
  offline: 'bg-gray-500',
};

export function PresenceDot({ userId, className = '' }: PresenceDotProps) {
  const status = usePresenceStore((s) => s.presences[userId] || 'offline');
  const colorClass = statusColors[status] || statusColors.offline;

  return (
    <div
      className={`h-3.5 w-3.5 rounded-full border-2 border-[var(--bg-primary)] ${colorClass} ${className}`}
      title={status.charAt(0).toUpperCase() + status.slice(1)}
    />
  );
}
