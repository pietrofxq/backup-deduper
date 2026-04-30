import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './apiClient.js';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({
  value,
  children,
}: {
  value: ApiClient;
  children: ReactNode;
}) {
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

/**
 * Read the singleton API client from context. Provided at the root in
 * production; tests that mount components under their own provider can
 * inject a mock.
 */
export function useApi(): ApiClient {
  const v = useContext(ApiContext);
  if (!v) throw new Error('useApi must be used inside <ApiProvider>');
  return v;
}
