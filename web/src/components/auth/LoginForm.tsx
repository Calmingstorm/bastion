import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, isLoading, error, clearError } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    try {
      await login(email, password);
      navigate('/app');
    } catch {
      // Error is already set in the store
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          Welcome back!
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          We're so excited to see you again!
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="email"
          className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"
        >
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="w-full rounded-[3px] border-none bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          placeholder="Enter your email"
        />
      </div>

      <div className="space-y-1">
        <label
          htmlFor="password"
          className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className="w-full rounded-[3px] border-none bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          placeholder="Enter your password"
        />
        <Link
          to="/forgot-password"
          className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline"
        >
          Forgot your password?
        </Link>
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className="w-full rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? 'Logging in...' : 'Log In'}
      </button>

      <p className="text-sm text-[var(--text-muted)]">
        Need an account?{' '}
        <Link
          to="/register"
          className="text-[var(--accent)] hover:underline"
        >
          Register
        </Link>
      </p>
    </form>
  );
}
