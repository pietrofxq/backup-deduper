import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.js';
import { ApiProvider } from './lib/apiContext.js';
import { createApiClient } from './lib/apiClient.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Local tool, low contention — keep things snappy but don't pound
      // the backend on every focus.
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const api = createApiClient();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing — index.html is broken');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ApiProvider value={api}>
        <RouterProvider router={router} />
      </ApiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
