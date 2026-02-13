import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoginForm } from '../components/auth/LoginForm';
import { useAuthStore } from '../stores/authStore';
import { isTauri, getPlatform } from '../platform';

export function LoginPage() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    // On desktop, redirect to setup if no server URL configured
    if (isTauri() && !getPlatform().storage.getItem('serverUrl')) {
      navigate('/setup', { replace: true });
      return;
    }
    if (isAuthenticated) {
      navigate('/app', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-tertiary)] p-4">
      <div className="w-full max-w-md rounded-md bg-[var(--bg-primary)] p-8 shadow-lg">
        <LoginForm />
      </div>
    </div>
  );
}
