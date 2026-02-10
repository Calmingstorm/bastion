import { useEffect, useState, useRef } from 'react';
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
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate(`/login?redirect=/invite/${code}`, { replace: true });
      return;
    }

    // Auto-join when authenticated
    if (!code || attemptedRef.current) return;
    attemptedRef.current = true;
    setIsJoining(true);

    apiJoinViaInvite(code)
      .then(async (server) => {
        await fetchServers();
        await selectServer(server.id);
        navigate('/app', { replace: true });
      })
      .catch((err: unknown) => {
        if (err && typeof err === 'object' && 'response' in err) {
          const axiosErr = err as { response?: { data?: { error?: string } } };
          setError(axiosErr.response?.data?.error || 'Failed to join server.');
        } else {
          setError('Failed to join server.');
        }
      })
      .finally(() => setIsJoining(false));
  }, [isAuthenticated, code, navigate, fetchServers, selectServer]);

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-tertiary)]">
      <div className="w-full max-w-sm rounded-md bg-[var(--bg-primary)] p-8 text-center shadow-xl">
        {isJoining ? (
          <>
            <div className="flex justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]" />
            </div>
            <p className="mt-4 text-sm text-[var(--text-secondary)]">Joining server...</p>
          </>
        ) : error ? (
          <>
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              Invite Failed
            </h1>
            <div className="mt-4 rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
              {error}
            </div>
            <button
              onClick={() => navigate('/app')}
              className="mt-6 rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
            >
              Go to App
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
