import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initPlatform } from './platform';
import App from './App';
import './styles/index.css';

initPlatform()
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  })
  .catch((err) => {
    console.error('Fatal startup error:', err);
    document.getElementById('root')!.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#e4e0ed;font-family:sans-serif"><div style="text-align:center"><h2>Failed to start</h2><button onclick="location.reload()" style="margin-top:12px;padding:8px 16px;border-radius:6px;background:#8b5cf6;color:white;border:none;cursor:pointer">Reload</button></div></div>';
  });
