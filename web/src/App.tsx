import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AppPage } from './pages/AppPage';
import { InvitePage } from './pages/InvitePage';

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
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-tertiary)]">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-[var(--text-muted)] border-t-[var(--accent)]" />
          <p className="text-sm text-[var(--text-muted)]">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/app" element={<AppPage />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
