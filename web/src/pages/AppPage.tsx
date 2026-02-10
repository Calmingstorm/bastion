import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useWSStore } from '../stores/wsStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useDMStore } from '../stores/dmStore';
import { AppLayout } from '../components/layout/AppLayout';

export function AppPage() {
  const { isAuthenticated, accessToken, logout } = useAuthStore();
  const { fetchServers, reset: resetServers } = useServerStore();
  const { connect, disconnect } = useWSStore();
  const { fetchReadStates, reset: resetUnread } = useUnreadStore();
  const { fetchDMs, reset: resetDMs } = useDMStore();
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

  // Handle logout from anywhere (e.g., token expiration)
  useEffect(() => {
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
