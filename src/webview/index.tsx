import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreContext, createEditorStore } from './state/editor';

const container = document.getElementById('root');
if (container) {
  const store = createEditorStore();
  createRoot(container).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </StrictMode>
  );
}
