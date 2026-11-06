/**
 * Rendered-Markdown diff Web Worker (#15679). Runs `buildMarkdownDiff` — the
 * patch reconstruction, both remark parses and the block and word LCS passes —
 * off the renderer's main thread, so a long document no longer freezes the pane
 * while its comparison is built. The engine is the same function the in-thread
 * path calls, so the verdict and the model cannot differ between the two.
 */

import { buildMarkdownDiff } from "../components/Worktree/markdownBlockDiff";
import type {
  MarkdownDiffWorkerRequest,
  MarkdownDiffWorkerResponse,
} from "../services/markdownDiffProtocol";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

function postTypedMessage(message: MarkdownDiffWorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<MarkdownDiffWorkerRequest>) => {
  const { id, input } = event.data;
  let response: MarkdownDiffWorkerResponse;
  try {
    response = { id, ok: true, result: buildMarkdownDiff(input) };
  } catch (err) {
    response = { id, ok: false, error: formatErrorMessage(err, "Markdown diff failed") };
  }
  postTypedMessage(response);
};
