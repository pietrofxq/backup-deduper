import { hashFile } from './sha256.js';

export interface HashJob {
  absPath: string;
  /** Echoed back in the result so callers can correlate without keeping a map. */
  cookie: number;
}

export interface HashResult {
  cookie: number;
  absPath: string;
  sha256: string | null;
  error: string | null;
}

/**
 * Hashing pool. Public API is queue-shaped so we can swap a worker_threads
 * backend in later without changing callers.
 *
 * Current backend: main-thread streaming SHA-256, processed in submission order
 * with a configurable concurrency window. This keeps the test surface and the
 * mover's re-hash path identical, and the IO pattern is fundamentally bound on
 * disk throughput (not CPU) for the typical large-file workload.
 */
export class HasherPool {
  private inflight = 0;
  private queue: Array<{
    job: HashJob;
    resolve: (r: HashResult) => void;
  }> = [];
  private closed = false;

  constructor(private readonly concurrency: number = 1) {
    if (concurrency < 1) throw new Error('concurrency must be >= 1');
  }

  hash(job: HashJob): Promise<HashResult> {
    if (this.closed) {
      return Promise.resolve({
        cookie: job.cookie,
        absPath: job.absPath,
        sha256: null,
        error: 'pool closed',
      });
    }
    return new Promise<HashResult>((resolve) => {
      this.queue.push({ job, resolve });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.inflight > 0 || this.queue.length > 0) {
      // Yield until drained.
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  private pump(): void {
    while (this.inflight < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.inflight += 1;
      void this.run(next.job)
        .then((r) => next.resolve(r))
        .finally(() => {
          this.inflight -= 1;
          this.pump();
        });
    }
  }

  private async run(job: HashJob): Promise<HashResult> {
    try {
      const sha = await hashFile(job.absPath);
      return { cookie: job.cookie, absPath: job.absPath, sha256: sha, error: null };
    } catch (err) {
      return {
        cookie: job.cookie,
        absPath: job.absPath,
        sha256: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
