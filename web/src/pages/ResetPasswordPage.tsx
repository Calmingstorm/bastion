import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiResetPassword } from '../api/client';
import { AxiosError } from 'axios';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setIsLoading(true);

    try {
      await apiResetPassword(token, password);
      setSuccess(true);
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

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg-tertiary)] p-4">
        <div className="w-full max-w-md rounded-md bg-[var(--bg-primary)] p-8 shadow-lg text-center space-y-4">
          <h1 className="text-2xl font-bold text-[var(--danger)]">
            Invalid Link
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">
            This password reset link is invalid or has expired.
          </p>
          <Link
            to="/forgot-password"
            className="inline-block text-sm text-[var(--accent)] hover:underline"
          >
            Request a new reset link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-tertiary)] p-4">
      <div className="w-full max-w-md rounded-md bg-[var(--bg-primary)] p-8 shadow-lg">
        {success ? (
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">
              Password reset!
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Your password has been updated. You can now log in with your new password.
            </p>
            <Link
              to="/login"
              className="inline-block rounded-[3px] bg-[var(--accent)] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
            >
              Log In
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="w-full space-y-5">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-[var(--text-primary)]">
                Set new password
              </h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Enter your new password below.
              </p>
            </div>

            {error && (
              <div className="rounded-md bg-[var(--danger)]/10 border border-[var(--danger)]/30 p-3 text-sm text-[var(--danger)]">
                {error}
              </div>
            )}

            <div className="space-y-1">
              <label
                htmlFor="password"
                className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"
              >
                New Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full rounded-[3px] border-none bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder="Enter new password"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="confirm-password"
                className="block text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]"
              >
                Confirm Password
              </label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full rounded-[3px] border-none bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder="Confirm new password"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
