import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initPlatform } from './platform';
import App from './App';
import './styles/index.css';

initPlatform().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
