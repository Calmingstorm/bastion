import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isTauri } from '../platform';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useWSStore } from '../stores/wsStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useDMStore } from '../stores/dmStore';
import { AppLayout } from '../components/layout/AppLayout';

export function AppPage() {
  // Targeted selectors to avoid cascading re-renders
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const logout = useAuthStore((s) => s.logout);
  const fetchServers = useServerStore((s) => s.fetchServers);
  const resetServers = useServerStore((s) => s.reset);
  const connect = useWSStore((s) => s.connect);
  const disconnect = useWSStore((s) => s.disconnect);
  const fetchReadStates = useUnreadStore((s) => s.fetchReadStates);
  const resetUnread = useUnreadStore((s) => s.reset);
  const fetchDMs = useDMStore((s) => s.fetchDMs);
  const resetDMs = useDMStore((s) => s.reset);
  const navigate = useNavigate();

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  // Fetch servers and connect WebSocket on mount
  useEffect(() => {
    if (isAuthenticated && accessToken) {
      fetchServers();
      fetchReadStates();
      fetchDMs();
      connect(accessToken);

      return () => {
        disconnect();
        resetServers();
        resetUnread();
        resetDMs();
      };
    }
    return undefined;
    // We deliberately only want to run this once on mount and when auth changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, accessToken]);

  // Handle logout from other browser tabs (not needed on desktop — single instance)
  useEffect(() => {
    if (isTauri()) return;

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'accessToken' && !e.newValue) {
        logout();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [logout]);

  if (!isAuthenticated) {
    return null;
  }

  return <AppLayout />;
}
