import type { CopyTreeOptions, CopyTreeResult, CopyTreeProgress } from "../types/index.js";
import type { CopyTreeTestConfigResult, FileTreeNode } from "../../shared/types/index.js";

/**
 * Message protocol between the workspace-host and the copytree worker thread.
 * Cancellation is a message (AbortSignal can't cross threads); the worker maps
 * it onto its own per-operation AbortController inside CopyTreeService.
 */
export type CopytreeWorkerRequest =
  // `outputPath` is chosen by the main process, never by a caller: with it set
  // the bundle is streamed to that file and only its path returns, so a
  // multi-MB string never crosses this port (#11528).
  | {
      type: "generate";
      id: string;
      rootPath: string;
      options: CopyTreeOptions;
      outputPath?: string;
    }
  | { type: "test-config"; id: string; rootPath: string; options: CopyTreeOptions }
  | {
      type: "get-file-tree";
      id: string;
      rootPath: string;
      dirPath?: string;
      options: CopyTreeOptions;
      includeExcluded?: boolean;
    }
  | { type: "cancel"; id: string };

export type CopytreeWorkerResponse =
  | { type: "progress"; id: string; progress: CopyTreeProgress }
  | { type: "generate-result"; id: string; result: CopyTreeResult }
  | { type: "generate-error"; id: string; error: string }
  | { type: "test-config-result"; id: string; result: CopyTreeTestConfigResult }
  | { type: "test-config-error"; id: string; error: string }
  // The file tree has no error-shaped result to fold a failure into the way
  // generate/test-config do, so a failed listing rejects the caller's promise.
  | { type: "get-file-tree-result"; id: string; nodes: FileTreeNode[] }
  | { type: "get-file-tree-error"; id: string; error: string };
