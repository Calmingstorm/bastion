import { useEffect, useState, Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { isTauri, isDesktopReady, isMobileReady, getPlatform } from './platform';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ServerSetupPage } from './pages/ServerSetupPage';
import { AppPage } from './pages/AppPage';
import { InvitePage } from './pages/InvitePage';

// Import theme store so it initializes and applies the saved theme on load
import './stores/themeStore';

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React Error Boundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-[var(--bg-tertiary)]">
          <div className="max-w-md rounded-lg bg-[var(--bg-secondary)] p-6 text-center">
            <h2 className="mb-2 text-lg font-bold text-[var(--danger)]">
              Something went wrong
            </h2>
            <p className="mb-4 text-sm text-[var(--text-muted)]">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { loadFromStorage } = useAuthStore();
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    loadFromStorage().finally(() => {
      setIsInitialized(true);
    });
  }, [loadFromStorage]);

  if (!isInitialized) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--bg-tertiary)]">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-[var(--text-muted)] border-t-[var(--accent)]" />
          <p className="text-sm text-[var(--text-muted)]">Loading...</p>
        </div>
      </div>
    );
  }

  // Desktop/Mobile: if platform init failed, show error
  if (isTauri() && !isDesktopReady() && !isMobileReady()) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--bg-tertiary)]">
        <div className="max-w-md rounded-lg bg-[var(--bg-secondary)] p-6 text-center">
          <h2 className="mb-2 text-lg font-bold text-[var(--danger)]">
            Platform Error
          </h2>
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            Failed to initialize the platform. Check the console for details.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Desktop hard gate: if no server URL configured, show setup page
  // OUTSIDE the router — no routing can bypass this
  if (isTauri() && !getPlatform().storage.getItem('serverUrl')) {
    return (
      <ErrorBoundary>
        <ServerSetupPage />
      </ErrorBoundary>
    );
  }

  const Router = isTauri() ? HashRouter : BrowserRouter;

  return (
    <ErrorBoundary>
      <Router>
        <Routes>
          <Route path="/setup" element={<ServerSetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/invite/:code" element={<InvitePage />} />
          <Route path="/app" element={<AppPage />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}
