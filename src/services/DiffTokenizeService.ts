/**
 * DiffTokenizeService - Client for the diff tokenization Web Worker.
 *
 * Owns one persistent worker shared by every diff viewer. Requests carry ids;
 * a newer request under the same key supersedes the older one (its promise
 * resolves null and any late worker response is dropped). If the worker can't
 * be constructed or a request errors, the client permanently falls back to
 * in-thread tokenization for the session.
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
}

function createDefaultWorker(): Worker {
  return new Worker(new URL("../workers/diffTokenize.worker.ts", import.meta.url), {
    type: "module",
  });
}

export class DiffTokenizeClient {
  private readonly createWorker: () => Worker;
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly latestByKey = new Map<string, number>();

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
        this.pending.delete(previousId);
        previous.resolve(null);
      }
    }
    this.latestByKey.set(key, id);

    const worker = this.workerFailed ? null : this.ensureWorker();
    if (!worker) return this.runInThread(key, id, request);

    return new Promise<DiffTokenizeResult | null>((resolve) => {
      this.pending.set(id, { key, request, resolve });
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
    this.pending.delete(response.id);
    this.clearLatest(entry.key, response.id);
    if (response.langLoadFailed) markLanguageFailed(entry.request.language);
    entry.resolve({ tokens: response.tokens, langLoadFailed: response.langLoadFailed });
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

  /** Fail over to in-thread tokenization, re-running still-relevant pending requests. */
  private failOver(err: unknown): void {
    this.enterFallback(err);
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of entries) {
      if (this.latestByKey.get(entry.key) !== id) {
        entry.resolve(null);
        continue;
      }
      void this.runInThread(entry.key, id, entry.request).then(entry.resolve);
    }
  }
}

export const diffTokenizeClient = new DiffTokenizeClient();
