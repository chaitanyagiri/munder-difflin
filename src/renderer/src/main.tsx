import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './design/global.css';

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/svg+xml';
favicon.href = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48"><path fill="#14283d" d="M20 2 36 8v13c0 11-6.4 19.4-16 25C10.4 40.4 4 32 4 21V8L20 2Z"/><path fill="#d8a72e" d="M20 8 31 12v9c0 8-4 14-11 18-7-4-11-10-11-18v-9l11-4Z"/><path fill="#14283d" d="M13 17h14v4H13zM18 13h4v14h-4z"/></svg>')}`;
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  splashMark.setAttribute('aria-label', 'The Precinct');
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
