import { describe, it, expect } from 'vitest';
import { ApiError, createApiClient } from '../apiClient.js';

/**
 * Unit tests for the API client. We don't spin up the real server here
 * (that's the contract test's job). Instead, we mock `fetch` and assert:
 *   - the right URL/method/body was emitted (so /api/* prefix is correct)
 *   - response JSON parses through the typed wrappers
 *   - error responses surface as ApiError with the parsed body
 *   - query strings serialise correctly (quarantine?runId=…)
 *
 * If we ever introduce a typo like `'/health'` (missing /api), this is the
 * test that catches it.
 */
describe('apiClient', () => {
  function makeFetchStub(
    handler: (url: string, init: RequestInit | undefined) => {
      status?: number;
      body: unknown;
    },
  ): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stub: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, init });
      const out = handler(url, init);
      const status = out.status ?? 200;
      const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      return new Response(text, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetch: stub, calls };
  }

  it('GET /health prefixes /api', async () => {
    const { fetch, calls } = makeFetchStub(() => ({
      body: { ok: true, targetRoot: '/tmp/x', uuid: 'u1' },
    }));
    const api = createApiClient({ fetch });
    const out = await api.health();
    expect(out).toEqual({ ok: true, targetRoot: '/tmp/x', uuid: 'u1' });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('/api/health');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('PUT /config sends JSON body and content-type', async () => {
    const { fetch, calls } = makeFetchStub(() => ({
      body: {
        active_preset: 'p',
        retention_days: 14,
        dry_run: true,
        dry_run_disabled_at: null,
        sanity_guard_files_pct: 0.5,
        sanity_guard_bytes_pct: 0.7,
      },
    }));
    const api = createApiClient({ fetch });
    const out = await api.putConfig({ retention_days: 14 });
    expect(out.retention_days).toBe(14);
    expect(calls[0]?.url).toBe('/api/config');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ retention_days: 14 }));
    expect(
      (calls[0]?.init?.headers as Record<string, string> | undefined)?.['content-type'],
    ).toBe('application/json');
  });

  it('GET /quarantine?runId=… serialises query params', async () => {
    const { fetch, calls } = makeFetchStub(() => ({ body: [] }));
    const api = createApiClient({ fetch });
    await api.listQuarantine(42);
    expect(calls[0]?.url).toBe('/api/quarantine?runId=42');
  });

  it('GET /quarantine without runId omits the query string', async () => {
    const { fetch, calls } = makeFetchStub(() => ({ body: [] }));
    const api = createApiClient({ fetch });
    await api.listQuarantine();
    expect(calls[0]?.url).toBe('/api/quarantine?');
  });

  it('non-2xx response throws ApiError with parsed body', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 400,
      body: { error: 'bad', kind: 'dry_run_gate' },
    }));
    const api = createApiClient({ fetch });
    await expect(api.startScan({ dryRun: false })).rejects.toBeInstanceOf(ApiError);
    try {
      await api.startScan({ dryRun: false });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(400);
      expect(e.body).toEqual({ error: 'bad', kind: 'dry_run_gate' });
      expect(e.message).toContain('bad');
    }
  });

  it('baseUrl is prepended when set (cross-origin / test mode)', async () => {
    const { fetch, calls } = makeFetchStub(() => ({ body: [] }));
    const api = createApiClient({ fetch, baseUrl: 'http://127.0.0.1:7777' });
    await api.listCollections();
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/collections');
  });

  it('POST /review/:id/decision uses the path id', async () => {
    const { fetch, calls } = makeFetchStub(() => ({ body: { ok: true } }));
    const api = createApiClient({ fetch });
    await api.decideReview(123, 'kept_both');
    expect(calls[0]?.url).toBe('/api/review/123/decision');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ status: 'kept_both' }));
  });
});
