import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { setAuthFailureHandler } from '../api/client';
import { useAuthStore } from '../stores/authStore';

// AuthFailureBridge wires the api client's auth-failure callback to router
// navigation. Rendered inside the router so useNavigate works, and so a terminal
// auth failure routes to /login (working under both BrowserRouter and Tauri's
// HashRouter) instead of the default hard window.location redirect. It logs out
// fully — clearing tokens, auth state, per-user stores, and in-flight requests —
// so /login does not immediately redirect back to /app on a still-authenticated
// store.
export function AuthFailureBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setAuthFailureHandler(() => {
      useAuthStore.getState().logout();
      navigate('/login', { replace: true });
    });
  }, [navigate]);
  return null;
}
