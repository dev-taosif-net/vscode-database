import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelHostMessage } from '../../shared/details';
import { App, applyHostMessage } from './App';
import { post } from './vscode';

window.addEventListener('message', (event: MessageEvent<PanelHostMessage>) => {
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

post({ type: 'ready' });
