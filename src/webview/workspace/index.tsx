import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryHostMessage } from '../../shared/query';
import { App } from './App';
import { applyHostMessage } from './store';
import { announceAddress, post } from './vscode';

window.addEventListener('message', (event: MessageEvent<QueryHostMessage>) => {
  applyHostMessage(event.data);
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

announceAddress();

// The host holds everything, so a page that has just mounted has nothing until
// it asks. That is also what makes a disposed webview cheap to bring back.
post({ type: 'ready' });
