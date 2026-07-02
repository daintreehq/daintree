/**
 * DiffTokenizeService - Client for the diff tokenization Web Worker.
 *
 * Owns one persistent worker shared by every diff viewer. Requests carry ids;
 * a newer request under the same key supersedes the older one (its promise
 * resolves null and any late worker response is dropped).
 *
 * Failure handling:
 * - A request unanswered for REQUEST_TIMEOUT_MS means the worker thread is
 *   wedged (pathological grammar regex or markEdits input). The request
 *   resolves null — the diff renders un-highlighted — and is never re-run:
 *   in-thread it would freeze the UI with the same pathology. The wedged
 *   worker is terminated (safe for renderer Web Workers, unlike Node
 *   worker_threads) and replaced, surviving requests move to the replacement,
 *   and after MAX_WORKER_REPLACEMENTS the client stops replacing and falls
 *   back permanently instead.
 * - Construction, postMessage, crash, and response errors skip the
 *   replacement budget and permanently fall back in-thread right away: they
 *   signal an environment problem, not a poisoned input.
 * - All in-thread tokenization — failover survivors AND every request issued
 *   while in permanent-fallback mode — flows through one shared serialized
 *   queue, run a single item at a time with a macrotask yield before each and
 *   newest-per-key winning. A dying worker can't dump a synchronous tokenize
 *   burst, and new fallback work is appended behind queued survivors instead
 *   of racing ahead of (or double-running with) them.
 */

import { runDiffTokenize } from "@/components/Worktree/diffTokenizer";
import type {
  DiffTokenizeRequest,
  DiffTokenizeResult,
  DiffTokenizeWorkerRequest,
  DiffTokenizeWorkerResponse,
} from "@/components/Worktree/diffTokenizer";
import { markLanguageFailed } from "@/components/Worktree/diffRefractor";

interface PendingRequest {
  key: string;
  request: DiffTokenizeRequest;
  resolve: (result: DiffTokenizeResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InThreadJob {
  key: string;
  id: number;
  request: DiffTokenizeRequest;
  resolve: (result: DiffTokenizeResult | null) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_WORKER_REPLACEMENTS = 2;

function createDefaultWorker(): Worker {
  return new Worker(new URL("../workers/diffTokenize.worker.ts", import.meta.url), {
    type: "module",
  });
}

function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class DiffTokenizeClient {
  private readonly createWorker: () => Worker;
  private worker: Worker | null = null;
  private workerFailed = false;
  private replacements = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly latestByKey = new Map<string, number>();
  private readonly inThreadQueue: InThreadJob[] = [];
  private draining = false;

  constructor(createWorker: () => Worker = createDefaultWorker) {
    this.createWorker = createWorker;
  }

  /**
   * Tokenize hunks off the main thread. Resolves null when a newer request
   * under the same key superseded this one — callers must ignore that result.
   */
  tokenize(key: string, request: DiffTokenizeRequest): Promise<DiffTokenizeResult | null> {
    const id = this.nextId++;
    const previousId = this.latestByKey.get(key);
    if (previousId !== undefined) {
      const previous = this.pending.get(previousId);
      if (previous) {
        clearTimeout(previous.timer);
        this.pending.delete(previousId);
        previous.resolve(null);
      }
    }
    this.latestByKey.set(key, id);

    const worker = this.workerFailed ? null : this.ensureWorker();
    if (!worker) return this.enqueueInThread(key, id, request);

    return new Promise<DiffTokenizeResult | null>((resolve) => {
      const timer = setTimeout(() => this.handleTimeout(id), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { key, request, resolve, timer });
      const message: DiffTokenizeWorkerRequest = { id, ...request };
      try {
        worker.postMessage(message);
      } catch (err) {
        this.failOver(err);
      }
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = this.createWorker();
    } catch (err) {
      this.enterFallback(err);
      return null;
    }
    this.worker.onmessage = (event: MessageEvent<DiffTokenizeWorkerResponse>) => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.failOver(event.error ?? new Error(event.message || "Diff tokenize worker error"));
    };
    this.worker.onmessageerror = () => {
      this.failOver(new Error("Diff tokenize worker message could not be deserialized"));
    };
    return this.worker;
  }

  private handleResponse(response: DiffTokenizeWorkerResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    if (!response.ok) {
      this.failOver(new Error(response.error));
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    this.clearLatest(entry.key, response.id);
    if (response.langLoadFailed) markLanguageFailed(entry.request.language);
    entry.resolve({ tokens: response.tokens, langLoadFailed: response.langLoadFailed });
  }

  private handleTimeout(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.clearLatest(entry.key, id);
    // "Oldest unanswered" is a heuristic for which request wedged the worker.
    // It resolves null (un-highlighted) and is never re-run in-thread — that
    // would freeze the UI with the same pathology. The tradeoff — a slow but
    // healthy request may be sacrificed and cost a replacement — is accepted:
    // the replacement worker re-serves all subsequent work, and a genuinely
    // poisoned input just times out again and triggers the next replacement.
    entry.resolve(null);
    if (this.replacements >= MAX_WORKER_REPLACEMENTS) {
      this.failOver(new Error("Diff tokenize worker kept timing out"));
      return;
    }
    this.replacements++;
    console.warn(
      `Diff tokenize request timed out after ${REQUEST_TIMEOUT_MS}ms; replacing the worker (${this.replacements}/${MAX_WORKER_REPLACEMENTS})`
    );
    this.replaceWorker();
  }

  /** Terminate the wedged worker and move surviving requests to a fresh one. */
  private replaceWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const worker = this.ensureWorker();
    if (!worker) {
      this.failOver(new Error("Diff tokenize worker replacement failed"));
      return;
    }
    for (const [id, entry] of [...this.pending.entries()]) {
      clearTimeout(entry.timer);
      if (this.latestByKey.get(entry.key) !== id) {
        this.pending.delete(id);
        entry.resolve(null);
        continue;
      }
      entry.timer = setTimeout(() => this.handleTimeout(id), REQUEST_TIMEOUT_MS);
      const message: DiffTokenizeWorkerRequest = { id, ...entry.request };
      try {
        worker.postMessage(message);
      } catch (err) {
        this.failOver(err);
        return;
      }
    }
  }

  private async runInThread(
    key: string,
    id: number,
    request: DiffTokenizeRequest
  ): Promise<DiffTokenizeResult | null> {
    const result = await runDiffTokenize(request);
    if (this.latestByKey.get(key) !== id) return null;
    this.latestByKey.delete(key);
    return result;
  }

  private clearLatest(key: string, id: number): void {
    if (this.latestByKey.get(key) === id) this.latestByKey.delete(key);
  }

  private enterFallback(err: unknown): void {
    if (!this.workerFailed) {
      this.workerFailed = true;
      console.warn(
        "Diff tokenize worker unavailable; tokenizing on the main thread for this session",
        err
      );
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /** Fail over to in-thread tokenization, queueing still-relevant pending requests. */
  private failOver(err: unknown): void {
    this.enterFallback(err);
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of entries) {
      clearTimeout(entry.timer);
      if (this.latestByKey.get(entry.key) !== id) {
        entry.resolve(null);
        continue;
      }
      this.inThreadQueue.push({
        key: entry.key,
        id,
        request: entry.request,
        resolve: entry.resolve,
      });
    }
    void this.pumpInThread();
  }

  private enqueueInThread(
    key: string,
    id: number,
    request: DiffTokenizeRequest
  ): Promise<DiffTokenizeResult | null> {
    return new Promise<DiffTokenizeResult | null>((resolve) => {
      this.inThreadQueue.push({ key, id, request, resolve });
      void this.pumpInThread();
    });
  }

  // Single runner for every in-thread tokenize (failover survivors and
  // permanent-fallback requests share this queue). One item at a time with a
  // yield before each keeps the main thread responsive; the per-item
  // supersession recheck drops any job no longer newest for its key so a
  // later same-key request wins without a double-run.
  private async pumpInThread(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inThreadQueue.length > 0) {
        await yieldToMacrotask();
        const job = this.inThreadQueue.shift();
        if (!job) break;
        if (this.latestByKey.get(job.key) !== job.id) {
          job.resolve(null);
          continue;
        }
        job.resolve(await this.runInThread(job.key, job.id, job.request));
      }
    } finally {
      this.draining = false;
    }
  }
}

export const diffTokenizeClient = new DiffTokenizeClient();
