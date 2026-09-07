/**
 * DiffTokenizeService - Client for the diff tokenization Web Worker.
 *
 * Owns one persistent worker shared by every diff viewer. Requests carry ids;
 * a newer request under the same key supersedes the older one (its promise
 * resolves null and any late worker response is dropped).
 *
 * Admission control:
 * - At most ONE job per key is ever on the worker. A request arriving while its
 *   key already has one in flight is HELD — not posted, no timeout timer — and
 *   replaces whatever was held before it. When the in-flight job settles, the
 *   held request is posted; everything superseded in between never reaches the
 *   worker at all. Stepping through a 20-file review therefore costs two jobs,
 *   not twenty: the worker is single-threaded, so a queue of jobs the client
 *   has already given up on IS the latency of the file the user is looking at.
 *   A posted job cannot be recalled (there is no cancel for postMessage, and
 *   terminating the worker would cost more than finishing one job and would
 *   drop the lazy grammar cache), so the gate has to sit in front of it.
 * - Keys are independent: a burst under one key never delays another's.
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
  /**
   * A newer same-key request arrived after this one was already on the worker.
   *
   * Its promise is settled null the moment that happens, exactly as before —
   * but the entry STAYS in `pending`, because the worker cannot un-run a job it
   * has already been handed. The entry is what the response (or the timeout)
   * lands on to release the key's in-flight slot and let the held request go;
   * dropping it here would strand that slot and the held request behind it
   * forever. Its result is discarded when it arrives, side effects included.
   */
  superseded: boolean;
}

/** A request that has not been handed to anything yet: held behind its key's in-flight job, or queued in-thread. */
interface TokenizeJob {
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
  /** The one id currently posted to the worker for each key. The admission gate. */
  private readonly inFlightByKey = new Map<string, number>();
  /** At most one not-yet-posted request per key, waiting for the in-flight one to settle. */
  private readonly heldByKey = new Map<string, TokenizeJob>();
  private readonly inThreadQueue: TokenizeJob[] = [];
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
    this.supersedePrevious(key);
    this.latestByKey.set(key, id);

    const worker = this.workerFailed ? null : this.ensureWorker();
    if (!worker) return this.enqueueInThread(key, id, request);

    // The key is busy: hold this one instead of posting it. No timer either —
    // a job that was never posted cannot have wedged anything.
    if (this.inFlightByKey.has(key)) {
      return new Promise<DiffTokenizeResult | null>((resolve) => {
        this.heldByKey.set(key, { key, id, request, resolve });
      });
    }

    return new Promise<DiffTokenizeResult | null>((resolve) => {
      this.dispatch(worker, { key, id, request, resolve });
    });
  }

  /**
   * Settle whatever this key was already waiting on, newest-wins.
   *
   * A held request is dropped outright — it never reached the worker, so there
   * is nothing to clean up. An in-flight one is settled null but deliberately
   * left in `pending`; see `PendingRequest.superseded`.
   */
  private supersedePrevious(key: string): void {
    const held = this.heldByKey.get(key);
    if (held) {
      this.heldByKey.delete(key);
      held.resolve(null);
      return;
    }
    const previousId = this.latestByKey.get(key);
    if (previousId === undefined) return;
    const previous = this.pending.get(previousId);
    if (!previous || previous.superseded) return;
    previous.superseded = true;
    previous.resolve(null);
  }

  /** Post a job to the worker and open the key's in-flight slot behind it. */
  private dispatch(worker: Worker, job: TokenizeJob): void {
    const timer = setTimeout(() => this.handleTimeout(job.id), REQUEST_TIMEOUT_MS);
    this.pending.set(job.id, {
      key: job.key,
      request: job.request,
      resolve: job.resolve,
      timer,
      superseded: false,
    });
    this.inFlightByKey.set(job.key, job.id);
    const message: DiffTokenizeWorkerRequest = { id: job.id, ...job.request };
    try {
      worker.postMessage(message);
    } catch (err) {
      this.failOver(err);
    }
  }

  /** Settle a held request null without running it anywhere. */
  private dropHeld(key: string): void {
    const held = this.heldByKey.get(key);
    if (!held) return;
    this.heldByKey.delete(key);
    this.clearLatest(key, held.id);
    held.resolve(null);
  }

  private releaseInFlight(key: string, id: number): void {
    if (this.inFlightByKey.get(key) === id) this.inFlightByKey.delete(key);
  }

  /**
   * Post the request held behind this key, now that the slot is free.
   *
   * Called on every path that settles an in-flight job. A held request that a
   * newer one superseded while it waited resolves null without running, and one
   * whose worker died on the way here goes to the in-thread queue rather than
   * being posted to nothing.
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
    // A superseded entry is a slot release and nothing else: its caller was
    // settled null when it was superseded, so neither its tokens nor its
    // failure are acted on. Before the gate, this response was dropped whole by
    // the `!entry` guard above — an obsolete error must not newly cost the
    // session its worker, and the grammar-failure signal it carries is
    // re-learned by the held request that takes its place.
    if (entry.superseded) {
      clearTimeout(entry.timer);
      this.pending.delete(response.id);
      this.releaseInFlight(entry.key, response.id);
      this.dispatchHeld(entry.key);
      return;
    }
    if (!response.ok) {
      this.failOver(new Error(response.error));
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    this.clearLatest(entry.key, response.id);
    this.releaseInFlight(entry.key, response.id);
    if (response.langLoadFailed) markLanguageFailed(entry.request.language);
    entry.resolve({ tokens: response.tokens, langLoadFailed: response.langLoadFailed });
    this.dispatchHeld(entry.key);
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
    this.releaseInFlight(entry.key, id);
    if (this.replacements >= MAX_WORKER_REPLACEMENTS) {
      // Fallback runs on the main thread, and this key's held successor is the
      // likeliest carrier of the input that just wedged three workers in a row
      // — same viewer, same file. Handing it to the fallback would freeze the
      // UI with exactly the pathology the timeout exists to contain, so it is
      // dropped for the same reason the timed-out request is never re-run.
      this.dropHeld(entry.key);
      this.failOver(new Error("Diff tokenize worker kept timing out"));
      return;
    }
    this.replacements++;
    console.warn(
      `Diff tokenize request timed out after ${REQUEST_TIMEOUT_MS}ms; replacing the worker (${this.replacements}/${MAX_WORKER_REPLACEMENTS})`
    );
    this.replaceWorker();
    // After the replacement exists, so the held request is posted to a live
    // worker rather than the one just terminated.
    this.dispatchHeld(entry.key);
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
    // Keys whose in-flight job was dropped here rather than re-posted: their
    // held request is next in line, but only once the loop is done posting.
    const freed: string[] = [];
    for (const [id, entry] of [...this.pending.entries()]) {
      clearTimeout(entry.timer);
      if (this.latestByKey.get(entry.key) !== id) {
        this.pending.delete(id);
        entry.resolve(null);
        this.releaseInFlight(entry.key, id);
        freed.push(entry.key);
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
    for (const key of freed) this.dispatchHeld(key);
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
    this.inFlightByKey.clear();
    const entries = [...this.pending.entries()];
    this.pending.clear();
    // Held requests never reached the worker, so they survive its death — but
    // they carry no `pending` row, so the sweep below would miss them and leave
    // their callers waiting on a promise nothing will ever settle.
    const held = [...this.heldByKey.values()];
    this.heldByKey.clear();
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
    for (const job of held) {
      if (this.latestByKey.get(job.key) !== job.id) {
        job.resolve(null);
        continue;
      }
      this.inThreadQueue.push(job);
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
