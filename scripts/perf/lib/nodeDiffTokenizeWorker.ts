import { parentPort } from "node:worker_threads";
import { runDiffTokenize } from "../../../src/components/Worktree/diffTokenizer";
import type {
  DiffTokenizeWorkerRequest,
  DiffTokenizeWorkerResponse,
} from "../../../src/components/Worktree/diffTokenizer";
import { formatErrorMessage } from "../../../shared/utils/errorMessage";

// node:worker_threads leg of the diff tokenize worker, for PERF-164. It mirrors
// `src/workers/diffTokenize.worker.ts` message for message and calls the SAME
// production `runDiffTokenize`, so the thing being measured is the real job,
// not a stand-in for one. It exists because the renderer's Web Worker has no
// Node equivalent and the in-thread fallback is not a valid subject for this
// scenario: `pumpInThread` already drops superseded work before running it, so
// the fallback would report the same count with or without admission control.
//
// The one addition is a job counter, incremented BEFORE the tokenizer is
// invoked. `executedJobs` is the scenario's whole subject, so it is counted
// where the work actually happens rather than inferred from what the client
// posted — the client's own bookkeeping is the thing under test and cannot
// also be the oracle.

if (!parentPort) {
  throw new Error("nodeDiffTokenizeWorker must run inside a worker_thread");
}

const port = parentPort;

/** Out-of-band request for the execution tally. Never forwarded to the client. */
export interface DiffTokenizeStatsRequest {
  control: "stats";
}

export interface DiffTokenizeStatsResponse {
  control: "stats";
  executed: number;
  executedIds: number[];
}

let executed = 0;
const executedIds: number[] = [];

// A response is not proof that everything received before it has finished:
// `runDiffTokenize` awaits a dynamic grammar import, so several jobs can be in
// flight at once. The tally is answered behind this accumulator so it is read
// at an idle point rather than mid-job.
let settled: Promise<unknown> = Promise.resolve();

port.on("message", (message: DiffTokenizeWorkerRequest | DiffTokenizeStatsRequest) => {
  if ("control" in message) {
    void settled.then(() => {
      port.postMessage({
        control: "stats",
        executed,
        executedIds: [...executedIds],
      } satisfies DiffTokenizeStatsResponse);
    });
    return;
  }

  const { id, ...request } = message;
  executed += 1;
  executedIds.push(id);
  const job = runDiffTokenize(request)
    .then((result) => {
      port.postMessage({ id, ok: true, ...result } satisfies DiffTokenizeWorkerResponse);
    })
    .catch((err: unknown) => {
      port.postMessage({
        id,
        ok: false,
        error: formatErrorMessage(err, "Tokenization failed"),
      } satisfies DiffTokenizeWorkerResponse);
    });
  settled = Promise.all([settled, job]);
});
