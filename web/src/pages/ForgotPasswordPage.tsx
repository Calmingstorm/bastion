import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiForgotPassword } from '../api/client';
import { AxiosError } from 'axios';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await apiForgotPassword(email);
      setSent(true);
    } catch (err) {
      if (err instanceof AxiosError && err.response?.data?.error) {
        setError(err.response.data.error);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-tertiary)] p-4">
      <div className="w-full max-w-md rounded-md bg-[var(--bg-primary)] p-8 shadow-lg">
        {sent ? (
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              Check your email
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              If an account exists for <strong>{email}</strong>, we've sent a password reset link.
            </p>
            <Link
              to="/login"
              className="inline-block text-sm text-[var(--accent)] hover:underline"
            >
              Back to login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="w-full space-y-5">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-[var(--text-primary)]">
                Forgot your password?
              </h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Enter your email and we'll send you a reset link.
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

            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? 'Sending...' : 'Send Reset Link'}
            </button>

            <p className="text-sm text-[var(--text-muted)]">
              <Link
                to="/login"
                className="text-[var(--accent)] hover:underline"
              >
                Back to login
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
