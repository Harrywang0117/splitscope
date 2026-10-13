import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// the project used to be called route-lens: keep this browser's theme, range and test basket
try {
  for (const k of ['range', 'theme', 'basket']) {
    const old = localStorage.getItem(`route-lens-${k}`);
    if (old !== null && localStorage.getItem(`splitscope-${k}`) === null) localStorage.setItem(`splitscope-${k}`, old);
    localStorage.removeItem(`route-lens-${k}`);
  }
} catch {
  /* storage unavailable */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
