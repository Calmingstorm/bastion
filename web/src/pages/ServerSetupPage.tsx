import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPlatform } from '../platform';
import { setApiBaseURL } from '../api/client';
import { setWSServerUrl } from '../api/websocket';

export function ServerSetupPage() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
      setError('Please enter a server URL.');
      return;
    }

    try {
      new URL(trimmed);
    } catch {
      setError('Invalid URL. Include the protocol (e.g., https://example.com).');
      return;
    }

    setTesting(true);
    try {
      const res = await fetch(`${trimmed}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
    } catch {
      setError('Could not reach the server. Check the URL and try again.');
      setTesting(false);
      return;
    }

    // Save and configure
    getPlatform().storage.setItem('serverUrl', trimmed);
    setApiBaseURL(trimmed);
    setWSServerUrl(trimmed);
    setTesting(false);
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-tertiary)]">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg bg-[var(--bg-secondary)] p-8"
      >
        <h1 className="mb-2 text-xl font-bold text-[var(--text-primary)]">
          Connect to Server
        </h1>
        <p className="mb-6 text-sm text-[var(--text-muted)]">
          Enter the URL of your Bastion server to get started.
        </p>

        <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
          Server URL
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://chat.example.com"
          className="mb-4 w-full rounded-[3px] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
          autoFocus
        />

        {error && (
          <p className="mb-4 text-sm text-[var(--danger)]">{error}</p>
        )}

        <button
          type="submit"
          disabled={testing}
          className="w-full rounded-[3px] bg-[var(--accent)] py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {testing ? 'Connecting...' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
