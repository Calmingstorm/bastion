import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { apiJoinViaInvite } from '../api/client';

export function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const { isAuthenticated } = useAuthStore();
  const { fetchServers, selectServer } = useServerStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      // Redirect to login, preserve invite path
      navigate(`/login?redirect=/invite/${code}`, { replace: true });
      return;
    }
  }, [isAuthenticated, code, navigate]);

  const handleJoin = async () => {
    if (!code) return;
    setIsJoining(true);
    setError(null);
    try {
      const server = await apiJoinViaInvite(code);
      await fetchServers();
      await selectServer(server.id);
      navigate('/app', { replace: true });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        setError(axiosErr.response?.data?.error || 'Failed to join server.');
      } else {
        setError('Failed to join server.');
      }
    } finally {
      setIsJoining(false);
    }
  };

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-tertiary)]">
      <div className="w-full max-w-sm rounded-md bg-[var(--bg-primary)] p-8 text-center shadow-xl">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          You've been invited!
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Invite code: <span className="font-mono text-[var(--accent)]">{code}</span>
        </p>

        {error && (
          <div className="mt-4 rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3">
          <button
            onClick={handleJoin}
            disabled={isJoining}
            className="rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {isJoining ? 'Joining...' : 'Accept Invite'}
          </button>
          <button
            onClick={() => navigate('/app')}
            className="rounded-[3px] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            Go Back
          </button>
        </div>
      </div>
    </div>
  );
}
