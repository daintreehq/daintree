/**
 * MarkdownDiffService - Client for the rendered-Markdown diff Web Worker (#15679).
 *
 * Owns one lazily created worker shared by every rendered diff in this view.
 * Requests carry ids; a newer request under the same key supersedes the older
 * one, whose promise resolves null and whose late response is dropped. Null is
 * never a verdict: callers treat it as "not yours any more".
 *
 * Admission is the `DiffTokenizeClient` gate: at most one job per key is on the
 * worker, and a request arriving while its key is busy is held (not posted)
 * and replaces whatever was held before it. Stepping j/k through a review of
 * long documents therefore runs the file in flight and the file the user landed
 * on, never every file passed on the way — the worker is single-threaded, so a
 * queue of comparisons nobody is waiting for IS the latency of the one they are.
 *
 * Failure handling differs from the tokenizer in one deliberate way. A
 * tokenize that times out can resolve null and leave the diff un-highlighted;
 * a comparison that resolved null here would leave the pane loading forever,
 * and one that resolved anything else would be a verdict the engine never
 * reached. So a timeout terminates and replaces the worker and re-posts every
 * still-current request with its promise intact, and once the replacement
 * budget is spent the client falls back to building in-thread — the same pure
 * function, so the same verdict, at the main-thread cost this client exists to
 * avoid. Construction, postMessage, crash, deserialization and engine-error
 * responses fall back in-thread immediately: they describe the environment, not
 * the input, and an engine that throws in the worker throws in-thread too,
 * where the rejection reaches the caller.
 *
 * In-thread work runs one job at a time from a single queue, with a macrotask
 * yield before each and a newest-per-key check, so a dying worker cannot dump a
 * burst of synchronous parses onto the main thread.
 */

import {
  buildMarkdownDiff,
  type MarkdownDiffResult,
  type ReconstructInput,
} from "@/components/Worktree/markdownBlockDiff";
import type { MarkdownDiffWorkerRequest, MarkdownDiffWorkerResponse } from "./markdownDiffProtocol";

/** A request not yet handed to anything: held behind its key, or queued in-thread. */
interface MarkdownDiffJob {
  key: string;
  id: number;
  input: ReconstructInput;
  resolve: (result: MarkdownDiffResult | null) => void;
  reject: (error: unknown) => void;
}

interface PostedJob extends MarkdownDiffJob {
  timer: ReturnType<typeof setTimeout>;
  /**
   * Settled null because a newer same-key request (or an abort) arrived after
   * this one was already posted. It stays in `posted` because the worker cannot
   * un-run it: its response or timeout is what releases the key's slot for the
   * held request.
   */
  superseded: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_WORKER_REPLACEMENTS = 2;

function createDefaultWorker(): Worker {
  return new Worker(new URL("../workers/markdownDiff.worker.ts", import.meta.url), {
    type: "module",
  });
}

function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class MarkdownDiffClient {
  private readonly createWorker: () => Worker;
  private worker: Worker | null = null;
  private workerFailed = false;
  private replacements = 0;
  private nextId = 1;
  private readonly posted = new Map<number, PostedJob>();
  private readonly latestByKey = new Map<string, number>();
  /** The one id on the worker for each key. The admission gate. */
  private readonly inFlightByKey = new Map<string, number>();
  private readonly heldByKey = new Map<string, MarkdownDiffJob>();
  private readonly inThreadQueue: MarkdownDiffJob[] = [];
  private draining = false;

  constructor(createWorker: () => Worker = createDefaultWorker) {
    this.createWorker = createWorker;
  }

  /**
   * Build a rendered-Markdown comparison off the main thread. Resolves null when
   * a newer request under the same key, or `signal`, superseded this one —
   * callers must ignore that. Rejects only when the engine itself threw.
   */
  build(
    key: string,
    input: ReconstructInput,
    signal?: AbortSignal
  ): Promise<MarkdownDiffResult | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const id = this.nextId++;
    this.supersedePrevious(key);
    this.latestByKey.set(key, id);

    return new Promise<MarkdownDiffResult | null>((resolvePromise, rejectPromise) => {
      const onAbort = () => this.cancel(key, id);
      const detach = () => signal?.removeEventListener("abort", onAbort);
      const job: MarkdownDiffJob = {
        key,
        id,
        input,
        resolve: (result) => {
          detach();
          resolvePromise(result);
        },
        reject: (error) => {
          detach();
          rejectPromise(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const worker = this.workerFailed ? null : this.ensureWorker();
      if (!worker) {
        this.inThreadQueue.push(job);
        void this.pumpInThread();
        return;
      }
      // The key is busy: hold this one instead of posting it. No timer either —
      // a job that was never posted cannot have wedged anything.
      if (this.inFlightByKey.has(key)) {
        this.heldByKey.set(key, job);
        return;
      }
      this.dispatch(worker, job);
    });
  }

  /** Terminate the worker and settle everything outstanding null. */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const outstanding: MarkdownDiffJob[] = [
      ...this.posted.values(),
      ...this.heldByKey.values(),
      ...this.inThreadQueue,
    ];
    for (const job of this.posted.values()) clearTimeout(job.timer);
    this.posted.clear();
    this.heldByKey.clear();
    this.inThreadQueue.length = 0;
    this.inFlightByKey.clear();
    this.latestByKey.clear();
    for (const job of outstanding) job.resolve(null);
  }

  /**
   * Settle whatever this key was already waiting on, newest-wins. A held or
   * queued request is dropped outright; a posted one is settled null but left
   * in `posted` (see `PostedJob.superseded`).
   */
  private supersedePrevious(key: string): void {
    const previousId = this.latestByKey.get(key);
    if (previousId !== undefined) this.release(key, previousId);
  }

  /** An abort from the caller: release the request only if it is still the key's newest. */
  private cancel(key: string, id: number): void {
    if (this.latestByKey.get(key) !== id) return;
    this.latestByKey.delete(key);
    this.release(key, id);
  }

  private release(key: string, id: number): void {
    const held = this.heldByKey.get(key);
    if (held?.id === id) {
      this.heldByKey.delete(key);
      held.resolve(null);
      return;
    }
    const posted = this.posted.get(id);
    if (posted) {
      if (!posted.superseded) {
        posted.superseded = true;
        posted.resolve(null);
      }
      return;
    }
    const queued = this.inThreadQueue.findIndex((job) => job.id === id);
    if (queued !== -1) {
      const [job] = this.inThreadQueue.splice(queued, 1);
      job?.resolve(null);
    }
  }

  /** Post a job to the worker and open the key's in-flight slot behind it. */
  private dispatch(worker: Worker, job: MarkdownDiffJob): void {
    const timer = setTimeout(() => this.handleTimeout(job.id), REQUEST_TIMEOUT_MS);
    this.posted.set(job.id, { ...job, timer, superseded: false });
    this.inFlightByKey.set(job.key, job.id);
    const message: MarkdownDiffWorkerRequest = { id: job.id, input: job.input };
    try {
      worker.postMessage(message);
    } catch (err) {
      this.failOver(err);
    }
  }

  private releaseInFlight(key: string, id: number): void {
    if (this.inFlightByKey.get(key) === id) this.inFlightByKey.delete(key);
  }

  /**
   * Post the request held behind this key, now that its slot is free. Called on
   * every path that settles a posted job.
   */
  private dispatchHeld(key: string): void {
    const held = this.heldByKey.get(key);
    if (!held) return;
    this.heldByKey.delete(key);
    if (this.latestByKey.get(key) !== held.id) {
      held.resolve(null);
      return;
    }
    const worker = this.workerFailed ? null : this.ensureWorker();
    if (!worker) {
      this.inThreadQueue.push(held);
      void this.pumpInThread();
      return;
    }
    this.dispatch(worker, held);
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (err) {
      this.enterFallback(err);
      return null;
    }
    this.worker = worker;
    // Every handler checks it still belongs to the live worker: a terminated
    // one can still have an event queued, and it must not settle requests that
    // were already moved to its replacement.
    worker.onmessage = (event: MessageEvent<MarkdownDiffWorkerResponse>) => {
      if (this.worker === worker) this.handleResponse(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.worker !== worker) return;
      this.failOver(event.error ?? new Error(event.message || "Markdown diff worker error"));
    };
    worker.onmessageerror = () => {
      if (this.worker !== worker) return;
      this.failOver(new Error("Markdown diff worker message could not be deserialized"));
    };
    return worker;
  }

  private handleResponse(response: MarkdownDiffWorkerResponse): void {
    const job = this.posted.get(response.id);
    if (!job) return;
    // A superseded job is a slot release and nothing else: its caller was
    // already settled null, so neither its result nor its error is acted on —
    // an obsolete failure must not cost the session its worker.
    if (job.superseded) {
      this.settlePosted(job);
      return;
    }
    if (!response.ok) {
      this.failOver(new Error(response.error));
      return;
    }
    this.settlePosted(job);
    this.clearLatest(job.key, job.id);
    job.resolve(response.result);
  }

  /** Close a posted job's bookkeeping and hand its slot to the held request. */
  private settlePosted(job: PostedJob): void {
    clearTimeout(job.timer);
    this.posted.delete(job.id);
    this.releaseInFlight(job.key, job.id);
    this.dispatchHeld(job.key);
  }

  private handleTimeout(id: number): void {
    const job = this.posted.get(id);
    if (!job) return;
    if (this.replacements >= MAX_WORKER_REPLACEMENTS) {
      this.failOver(new Error("Markdown diff worker kept timing out"));
      return;
    }
    this.replacements++;
    console.warn(
      `Markdown diff request timed out after ${REQUEST_TIMEOUT_MS}ms; replacing the worker (${this.replacements}/${MAX_WORKER_REPLACEMENTS})`
    );
    this.replaceWorker();
  }

  /**
   * Terminate the wedged worker and re-post every still-current request to a
   * fresh one, promises intact. Superseded jobs are dropped here — nothing is
   * waiting on them — which frees their keys for the held requests behind them.
   */
  private replaceWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const worker = this.ensureWorker();
    if (!worker) {
      this.failOver(new Error("Markdown diff worker replacement failed"));
      return;
    }
    const freed: string[] = [];
    for (const job of [...this.posted.values()]) {
      clearTimeout(job.timer);
      if (job.superseded) {
        this.posted.delete(job.id);
        this.releaseInFlight(job.key, job.id);
        freed.push(job.key);
        continue;
      }
      job.timer = setTimeout(() => this.handleTimeout(job.id), REQUEST_TIMEOUT_MS);
      const message: MarkdownDiffWorkerRequest = { id: job.id, input: job.input };
      try {
        worker.postMessage(message);
      } catch (err) {
        this.failOver(err);
        return;
      }
    }
    for (const key of freed) this.dispatchHeld(key);
  }

  private clearLatest(key: string, id: number): void {
    if (this.latestByKey.get(key) === id) this.latestByKey.delete(key);
  }

  private enterFallback(err: unknown): void {
    if (!this.workerFailed) {
      this.workerFailed = true;
      console.warn(
        "Markdown diff worker unavailable; building rendered diffs on the main thread for this session",
        err
      );
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  /** Fall back to in-thread builds, queueing every still-current request. */
  private failOver(err: unknown): void {
    this.enterFallback(err);
    this.inFlightByKey.clear();
    const posted = [...this.posted.values()];
    this.posted.clear();
    // Held requests never reached the worker, so they survive its death — but
    // they have no `posted` row, so they need their own sweep or their callers
    // wait on a promise nothing settles.
    const held = [...this.heldByKey.values()];
    this.heldByKey.clear();
    for (const job of posted) {
      clearTimeout(job.timer);
      if (job.superseded) continue;
      this.inThreadQueue.push(job);
    }
    for (const job of held) this.inThreadQueue.push(job);
    void this.pumpInThread();
  }

  private async pumpInThread(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.inThreadQueue.length > 0) {
      await yieldToMacrotask();
      const job = this.inThreadQueue.shift();
      if (!job) break;
      if (this.latestByKey.get(job.key) !== job.id) {
        job.resolve(null);
        continue;
      }
      let result: MarkdownDiffResult;
      try {
        result = buildMarkdownDiff(job.input);
      } catch (err) {
        this.clearLatest(job.key, job.id);
        job.reject(err);
        continue;
      }
      this.clearLatest(job.key, job.id);
      job.resolve(result);
    }
    this.draining = false;
  }
}

export const markdownDiffClient = new MarkdownDiffClient();
