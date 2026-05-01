import { useEffect, useRef, useState } from 'react';

/**
 * Subscribe to `/api/events` via EventSource. Only the most recent event of
 * each type is exposed to consumers (the Dashboard's progress panel cares
 * about the *current* phase / current hashed file, not the full history).
 *
 * The connection is opened once for the page lifetime and reconnects via
 * the browser's built-in EventSource retry. `Last-Event-ID` is supplied
 * automatically by the browser, so the bus's replay window covers any
 * dropped frames.
 */
export interface ScanProgressState {
  connected: boolean;
  /** Current scan run id (set on the first event from a run). */
  runId: number | null;
  /** 'started' | 'scan' | 'classify' | 'report' | 'execute' | 'done' | 'aborted' | 'failed'. */
  phase: string | null;
  /** Most-recent `discovered` event payload (per collection). */
  discovered: { collection: string; files: number } | null;
  /** Most-recent `hashed` payload — used to render the progress bar. */
  hashed: {
    collection: string;
    relPath: string;
    index: number;
    total: number;
  } | null;
  /** Counts emitted at the end of the classifier step. */
  classified: {
    actions: number;
    reviewPairs: number;
    emptyDirs: number;
  } | null;
  /** Reason string when the run terminated abnormally. */
  error: string | null;
  /** True when a `done` event has arrived for the current run. */
  finished: boolean;
}

const INITIAL: ScanProgressState = {
  connected: false,
  runId: null,
  phase: null,
  discovered: null,
  hashed: null,
  classified: null,
  error: null,
  finished: false,
};

export function useScanEvents(baseUrl = ''): ScanProgressState & { reset: () => void } {
  const [state, setState] = useState<ScanProgressState>(INITIAL);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // jsdom doesn't ship EventSource — bail out cleanly so unit tests don't
    // throw. Production browsers all have it.
    if (typeof EventSource === 'undefined') return;

    const url = `${baseUrl}/api/events`;
    const es = new EventSource(url);
    sourceRef.current = es;

    es.addEventListener('open', () => {
      setState((s) => ({ ...s, connected: true }));
    });
    es.addEventListener('error', () => {
      // EventSource auto-retries; reflect transient disconnect in UI.
      setState((s) => ({ ...s, connected: false }));
    });

    const onPhase = (e: MessageEvent) => {
      const payload = parse(e.data);
      if (!payload) return;
      setState((s) => ({
        ...s,
        runId: extractRunId(payload) ?? s.runId,
        phase: typeof payload.phase === 'string' ? payload.phase : s.phase,
        // 'started' resets per-run state; otherwise carry forward.
        ...(payload.phase === 'started'
          ? { hashed: null, discovered: null, classified: null, finished: false, error: null }
          : {}),
      }));
    };
    const onDiscovered = (e: MessageEvent) => {
      const payload = parse(e.data);
      if (!payload) return;
      setState((s) => ({
        ...s,
        runId: extractRunId(payload) ?? s.runId,
        discovered: { collection: payload.collection as string, files: payload.files as number },
      }));
    };
    const onHashed = (e: MessageEvent) => {
      const payload = parse(e.data);
      if (!payload) return;
      setState((s) => ({
        ...s,
        runId: extractRunId(payload) ?? s.runId,
        hashed: {
          collection: payload.collection as string,
          relPath: payload.relPath as string,
          index: payload.index as number,
          total: payload.total as number,
        },
      }));
    };
    const onClassified = (e: MessageEvent) => {
      const payload = parse(e.data);
      if (!payload) return;
      setState((s) => ({
        ...s,
        runId: extractRunId(payload) ?? s.runId,
        classified: {
          actions: payload.actions as number,
          reviewPairs: payload.reviewPairs as number,
          emptyDirs: payload.emptyDirs as number,
        },
      }));
    };
    const onDone = (e: MessageEvent) => {
      const payload = parse(e.data);
      if (!payload) return;
      setState((s) => ({
        ...s,
        runId: extractRunId(payload) ?? s.runId,
        phase: 'done',
        finished: true,
      }));
    };
    const onAborted = (e: MessageEvent) => {
      const payload = parse(e.data);
      setState((s) => ({
        ...s,
        runId: (payload?.runId as number | null) ?? s.runId,
        phase: 'aborted',
        finished: true,
        error: 'cancelled by user',
      }));
    };
    const onFailed = (e: MessageEvent) => {
      const payload = parse(e.data);
      setState((s) => ({
        ...s,
        runId: (payload?.runId as number | null) ?? s.runId,
        phase: 'failed',
        finished: true,
        error:
          (payload && typeof payload.error === 'string' ? payload.error : null) ??
          'scan failed',
      }));
    };

    es.addEventListener('phase', onPhase);
    es.addEventListener('discovered', onDiscovered);
    es.addEventListener('hashed', onHashed);
    es.addEventListener('classified', onClassified);
    es.addEventListener('done', onDone);
    es.addEventListener('aborted', onAborted);
    es.addEventListener('failed', onFailed);

    return () => {
      es.removeEventListener('phase', onPhase);
      es.removeEventListener('discovered', onDiscovered);
      es.removeEventListener('hashed', onHashed);
      es.removeEventListener('classified', onClassified);
      es.removeEventListener('done', onDone);
      es.removeEventListener('aborted', onAborted);
      es.removeEventListener('failed', onFailed);
      es.close();
      sourceRef.current = null;
    };
  }, [baseUrl]);

  return {
    ...state,
    reset: () => setState({ ...INITIAL, connected: state.connected }),
  };
}

function extractRunId(payload: Record<string, unknown> | null): number | null {
  const raw = payload?.runId;
  return typeof raw === 'number' ? raw : null;
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string' || data.length === 0) return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
