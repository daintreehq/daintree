/**
 * Diff Tokenization Web Worker
 *
 * Runs react-diff-view's tokenize (refractor syntax highlighting, markEdits
 * word-level diffing, pickRanges search/whitespace marks) off the renderer
 * main thread so large diffs can't freeze the UI. Grammars lazy-load per
 * language inside the worker via the same shared loader map the in-thread
 * fallback uses.
 */

import { runDiffTokenize } from "../components/Worktree/diffTokenizer";
import type {
  DiffTokenizeWorkerRequest,
  DiffTokenizeWorkerResponse,
} from "../components/Worktree/diffTokenizer";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

function postTypedMessage(message: DiffTokenizeWorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<DiffTokenizeWorkerRequest>) => {
  const { id, ...request } = event.data;
  void runDiffTokenize(request)
    .then((result) => {
      postTypedMessage({ id, ok: true, ...result });
    })
    .catch((err: unknown) => {
      postTypedMessage({ id, ok: false, error: formatErrorMessage(err, "Tokenization failed") });
    });
};
