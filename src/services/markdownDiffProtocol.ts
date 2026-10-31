import type { MarkdownDiffResult, ReconstructInput } from "@/components/Worktree/markdownBlockDiff";

/** One comparison posted to the rendered-Markdown diff worker. */
export interface MarkdownDiffWorkerRequest {
  id: number;
  input: ReconstructInput;
}

/**
 * The worker's answer. An engine refusal (`too-large`, `source-mismatch`, …) is
 * an ordinary `ok: true` carrying `{ ok: false, reason }`: it is a verdict, not
 * a failure of the worker. `ok: false` means the engine threw.
 */
export type MarkdownDiffWorkerResponse =
  { id: number; ok: true; result: MarkdownDiffResult } | { id: number; ok: false; error: string };
