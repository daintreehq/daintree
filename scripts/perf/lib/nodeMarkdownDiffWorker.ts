import { parentPort, threadId } from "node:worker_threads";
import { buildMarkdownDiff } from "../../../src/components/Worktree/markdownBlockDiff";
import type {
  MarkdownDiffWorkerRequest,
  MarkdownDiffWorkerResponse,
} from "../../../src/services/markdownDiffProtocol";
import { formatErrorMessage } from "../../../shared/utils/errorMessage";

// node:worker_threads leg of the rendered-Markdown diff worker, for PERF-419
// and PERF-420. It mirrors `src/workers/markdownDiff.worker.ts` message for
// message and calls the SAME production `buildMarkdownDiff`, so what is
// measured is the real job. The one addition is an execution tally, counted
// where the work happens rather than inferred from what the client posted —
// the client's bookkeeping is part of the subject and cannot also be the
// oracle for whether the worker ran.

if (!parentPort) {
  throw new Error("nodeMarkdownDiffWorker must run inside a worker_thread");
}

const port = parentPort;

export interface MarkdownDiffStatsRequest {
  control: "stats";
}

export interface MarkdownDiffStatsResponse {
  control: "stats";
  executedIds: number[];
  threadId: number;
}

const executedIds: number[] = [];

port.on("message", (message: MarkdownDiffWorkerRequest | MarkdownDiffStatsRequest) => {
  // The build is synchronous, so messages are handled strictly in order and a
  // stats request is always answered after every job posted before it.
  if ("control" in message) {
    port.postMessage({
      control: "stats",
      executedIds: [...executedIds],
      threadId,
    } satisfies MarkdownDiffStatsResponse);
    return;
  }
  executedIds.push(message.id);
  let response: MarkdownDiffWorkerResponse;
  try {
    response = { id: message.id, ok: true, result: buildMarkdownDiff(message.input) };
  } catch (err) {
    response = {
      id: message.id,
      ok: false,
      error: formatErrorMessage(err, "Markdown diff failed"),
    };
  }
  port.postMessage(response);
});
