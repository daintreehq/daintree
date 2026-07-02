import type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress } from "../types/index.js";
import type { CopyTreeTestConfigResult } from "../../shared/types/index.js";

/**
 * Message protocol between the workspace-host and the copytree worker thread.
 * Cancellation is a message (AbortSignal can't cross threads); the worker maps
 * it onto its own per-operation AbortController inside CopyTreeService.
 */
export type CopytreeWorkerRequest =
  | { type: "generate"; id: string; rootPath: string; options: CopyTreeOptions }
  | { type: "test-config"; id: string; rootPath: string; options: CopyTreeOptions }
  | { type: "cancel"; id: string };

export type CopytreeWorkerResponse =
  | { type: "progress"; id: string; progress: CopyTreeProgress }
  | { type: "generate-result"; id: string; result: CopyTreeResult }
  | { type: "generate-error"; id: string; error: string }
  | { type: "test-config-result"; id: string; result: CopyTreeTestConfigResult }
  | { type: "test-config-error"; id: string; error: string };
