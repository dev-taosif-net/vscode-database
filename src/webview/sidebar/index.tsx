import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar } from './Sidebar';

/**
 * The sidebar's own entry point.
 *
 * It shares no bundle with the connection editor. The sidebar is resolved at
 * startup and the editor is not, so a shared bundle would make opening the
 * panel pay for a form nobody has asked for — and `api.ts` acquires the VS Code
 * bridge for itself, because acquiring it twice in one document throws.
 */
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Sidebar />
    </StrictMode>
  );
}
