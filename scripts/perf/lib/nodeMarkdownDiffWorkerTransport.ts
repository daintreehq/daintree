// Aliased so bare `Worker` in type position stays the DOM interface — the one
// `MarkdownDiffClient` is written against.
import { Worker as NodeWorker } from "node:worker_threads";
import type { ReconstructInput } from "../../../src/components/Worktree/markdownBlockDiff";
import type {
  MarkdownDiffWorkerRequest,
  MarkdownDiffWorkerResponse,
} from "../../../src/services/markdownDiffProtocol";
import type { MarkdownDiffStatsRequest, MarkdownDiffStatsResponse } from "./nodeMarkdownDiffWorker";

// Presents the browser `Worker` surface `MarkdownDiffClient` drives, over a real
// `node:worker_threads` thread running the production engine. The client is
// measured UNMODIFIED. Child threads do not inherit tsx's loader, so it is
// re-registered through `execArgv`, as `nodeDiffTokenizeWorkerTransport.ts`
// does. Structured cloning of the input on post and of the model on delivery
// happens on this thread, exactly as it does in the renderer.
//
// The transport records what the client cannot be asked: which ids crossed
// `postMessage`, which responses were delivered, and (from the worker's own
// tally) which jobs actually ran and on which thread. Control traffic is
// answered here and never reaches the client.

export interface MarkdownDiffWorkerStats {
  executedIds: number[];
  threadId: number;
}

export class NodeMarkdownDiffWorkerHarness {
  onmessage: ((event: MessageEvent<MarkdownDiffWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  /** Ids that actually crossed `postMessage`, in order. */
  readonly posted: number[] = [];
  /**
   * The input each of those posts carried, by reference — the object the caller
   * handed the client, captured before the structured clone. It is how an
   * observer tells WHICH selection reached the worker without trusting ids.
   */
  readonly postedInputs: ReconstructInput[] = [];
  /** Ids whose response was handed to the client, in order. */
  readonly delivered: number[] = [];
  /** Transport-level breakage. A run that saw any of this measured nothing. */
  readonly failures: string[] = [];

  private readonly thread: NodeWorker;
  private readonly exited: Promise<void>;
  private statsWaiters: Array<(stats: MarkdownDiffWorkerStats) => void> = [];
  private closing = false;

  constructor() {
    this.thread = new NodeWorker(new URL("./nodeMarkdownDiffWorker.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
    });
    this.exited = new Promise<void>((resolve) => {
      this.thread.once("exit", () => resolve());
    });

    this.thread.on("message", (message: MarkdownDiffWorkerResponse | MarkdownDiffStatsResponse) => {
      if ("control" in message) {
        this.settleStats(message);
        return;
      }
      this.delivered.push(message.id);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal MessageEvent shape, the only part of it the client reads
      this.onmessage?.({ data: message } as MessageEvent<MarkdownDiffWorkerResponse>);
    });
    this.thread.on("messageerror", () => {
      this.onmessageerror?.();
    });
    this.thread.on("error", (error: Error) => {
      this.fail(error.message || "node markdown diff worker error", error);
    });
    // An exit with no error event (loader failure, OOM kill) must still settle
    // anything waiting, or the scenario hangs instead of reporting a failure.
    this.thread.on("exit", (code: number) => {
      if (this.closing) return;
      this.fail(`node markdown diff worker exited (code ${code})`);
    });
  }

  postMessage(message: MarkdownDiffWorkerRequest): void {
    this.posted.push(message.id);
    this.postedInputs.push(message.input);
    this.thread.postMessage(message);
  }

  terminate(): void {
    this.closing = true;
    this.settleStats({ control: "stats", executedIds: [], threadId: 0 });
    void this.thread.terminate();
  }

  /** The worker's own tally, read after everything already posted has run. */
  stats(): Promise<MarkdownDiffWorkerStats> {
    if (this.closing) return Promise.resolve({ executedIds: [], threadId: 0 });
    return new Promise<MarkdownDiffWorkerStats>((resolve) => {
      this.statsWaiters.push(resolve);
      this.thread.postMessage({ control: "stats" } satisfies MarkdownDiffStatsRequest);
    });
  }

  /** Terminate the thread and wait for it to be gone. */
  async close(): Promise<void> {
    if (!this.closing) this.terminate();
    await this.exited;
  }

  private settleStats(message: MarkdownDiffStatsResponse): void {
    const waiters = this.statsWaiters;
    this.statsWaiters = [];
    for (const resolve of waiters) {
      resolve({ executedIds: message.executedIds, threadId: message.threadId });
    }
  }

  private fail(message: string, error?: Error): void {
    this.failures.push(message);
    this.settleStats({ control: "stats", executedIds: [], threadId: 0 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal ErrorEvent shape, the only part of it the client reads
    this.onerror?.({ message, error } as ErrorEvent);
  }
}

/** A factory `MarkdownDiffClient` accepts, plus the harnesses it made. */
export function createNodeMarkdownDiffWorkerFactory(): {
  factory: () => Worker;
  harnesses: NodeMarkdownDiffWorkerHarness[];
} {
  const harnesses: NodeMarkdownDiffWorkerHarness[] = [];
  return {
    harnesses,
    factory: () => {
      const harness = new NodeMarkdownDiffWorkerHarness();
      harnesses.push(harness);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the harness implements the Worker surface the client uses
      return harness as unknown as Worker;
    },
  };
}
