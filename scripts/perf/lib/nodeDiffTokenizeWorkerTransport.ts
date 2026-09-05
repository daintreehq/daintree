// Aliased so bare `Worker` in type position stays the DOM interface — the one
// `DiffTokenizeClient` is written against.
import { Worker as NodeWorker } from "node:worker_threads";
import type {
  DiffTokenizeWorkerRequest,
  DiffTokenizeWorkerResponse,
} from "../../../src/components/Worktree/diffTokenizer";
import type { DiffTokenizeStatsRequest, DiffTokenizeStatsResponse } from "./nodeDiffTokenizeWorker";

// Presents the browser `Worker` surface `DiffTokenizeClient` drives — over a
// real `node:worker_threads` thread running the production tokenizer. The
// client is measured UNMODIFIED: PERF-164's subject is its admission
// behaviour, so anything that changed the client to make it observable would
// measure a different client. Child threads do not inherit tsx's loader, so it
// is re-registered through `execArgv`, the same way
// `nodeParseWorkerTransport.ts` does it.
//
// The transport observes two things the client does not expose: which ids
// actually crossed `postMessage`, and (via the worker's own tally) which the
// worker actually ran. Control traffic is answered here and never forwarded to
// the client, so the client sees exactly the protocol it sees in production.

export interface DiffTokenizeWorkerStats {
  executed: number;
  executedIds: number[];
}

export class NodeDiffTokenizeWorkerHarness {
  onmessage: ((event: MessageEvent<DiffTokenizeWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  /** Ids that actually crossed `postMessage`, in order. */
  readonly posted: number[] = [];
  /** Transport-level breakage. A scenario that saw any of this measured nothing. */
  readonly failures: string[] = [];

  private readonly thread: NodeWorker;
  private readonly exited: Promise<void>;
  private statsWaiters: Array<(stats: DiffTokenizeWorkerStats) => void> = [];
  private closing = false;

  constructor() {
    this.thread = new NodeWorker(new URL("./nodeDiffTokenizeWorker.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
    });
    this.exited = new Promise<void>((resolve) => {
      this.thread.once("exit", () => resolve());
    });

    this.thread.on("message", (message: DiffTokenizeWorkerResponse | DiffTokenizeStatsResponse) => {
      if ("control" in message) {
        this.settleStats(message);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal MessageEvent shape, the only part of it the client reads
      this.onmessage?.({ data: message } as MessageEvent<DiffTokenizeWorkerResponse>);
    });

    this.thread.on("error", (error: Error) => {
      this.fail(error.message || "node diff tokenize worker error", error);
    });

    // An exit with no error event (loader failure, OOM kill) must still settle
    // anything waiting, or the scenario hangs instead of reporting a failure.
    this.thread.on("exit", (code: number) => {
      if (this.closing) return;
      this.fail(`node diff tokenize worker exited (code ${code})`);
    });
  }

  postMessage(message: DiffTokenizeWorkerRequest): void {
    this.posted.push(message.id);
    this.thread.postMessage(message);
  }

  terminate(): void {
    this.closing = true;
    void this.thread.terminate();
  }

  /** The worker's own execution tally, read once everything already sent has settled. */
  stats(): Promise<DiffTokenizeWorkerStats> {
    if (this.closing) return Promise.resolve({ executed: 0, executedIds: [] });
    return new Promise<DiffTokenizeWorkerStats>((resolve) => {
      this.statsWaiters.push(resolve);
      this.thread.postMessage({ control: "stats" } satisfies DiffTokenizeStatsRequest);
    });
  }

  /** Terminate and wait for the thread to actually go, so the process can exit. */
  async close(): Promise<void> {
    this.closing = true;
    this.settleStats({ control: "stats", executed: 0, executedIds: [] });
    await this.thread.terminate();
    await this.exited;
  }

  private settleStats(message: DiffTokenizeStatsResponse): void {
    const waiters = this.statsWaiters;
    this.statsWaiters = [];
    for (const waiter of waiters) {
      waiter({ executed: message.executed, executedIds: message.executedIds });
    }
  }

  private fail(message: string, error?: Error): void {
    this.failures.push(message);
    this.settleStats({ control: "stats", executed: 0, executedIds: [] });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal ErrorEvent shape, the only part of it the client reads
    this.onerror?.({ message, error } as unknown as ErrorEvent);
  }
}

export function createNodeDiffTokenizeWorker(): {
  harness: NodeDiffTokenizeWorkerHarness;
  factory: () => Worker;
} {
  const harness = new NodeDiffTokenizeWorkerHarness();
  return {
    harness,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the harness implements exactly the Worker surface DiffTokenizeClient uses
    factory: () => harness as unknown as Worker,
  };
}
