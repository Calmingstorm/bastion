import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RegisterForm } from '../components/auth/RegisterForm';
import { useAuthStore } from '../stores/authStore';

export function RegisterPage() {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/app', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-tertiary)] p-4">
      <div className="w-full max-w-md rounded-md bg-[var(--bg-primary)] p-8 shadow-lg">
        <RegisterForm />
      </div>
    </div>
  );
}
