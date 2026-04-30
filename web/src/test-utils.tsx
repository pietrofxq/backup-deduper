import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiProvider } from './lib/apiContext.js';
import type { ApiClient } from './lib/apiClient.js';

/**
 * A typed-shape API mock that satisfies the ApiClient interface. Tests pass
 * a `Partial<ApiClient>`; everything not overridden throws so a missed
 * method shows up as an obvious test failure rather than a silent `undefined`.
 */
export function buildMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const handler: ProxyHandler<ApiClient> = {
    get(target, prop, recv) {
      if (prop in target) return Reflect.get(target, prop, recv);
      return () => {
        throw new Error(`mock api: ${String(prop)} not stubbed in this test`);
      };
    },
  };
  return new Proxy(overrides as ApiClient, handler);
}

interface RenderArgs extends Omit<RenderOptions, 'wrapper'> {
  api?: ApiClient;
}

export function renderWithProviders(ui: ReactElement, args: RenderArgs = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const api = args.api ?? buildMockApi();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ApiProvider value={api}>{children}</ApiProvider>
      </QueryClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...args });
}
