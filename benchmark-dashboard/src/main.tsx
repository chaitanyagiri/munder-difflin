import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../../src/renderer/src/design/global.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
