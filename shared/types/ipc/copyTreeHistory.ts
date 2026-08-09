/**
 * Per-project record of copy-tree runs (#11732).
 *
 * Every delivery mode — clipboard file, bare generate, terminal injection —
 * funnels through the three main-process handlers in
 * `electron/ipc/handlers/copyTree.ts`, so recording there captures the toolbar,
 * both context menus, the file browser and MCP in one place.
 *
 * Unlike the process-global run-history ring (#9949), this history is scoped to
 * a single project: it lives in `userData/projects/<projectId>/copy-tree-history.json`
 * alongside `settings.json` / `recipes.json`, and its snapshot push goes only to
 * views bound to that project.
 *
 * Records store the caller's runtime options *before* `mergeCopyTreeOptions`
 * folds in project settings. Re-running dispatches those options through the
 * normal path so live settings and excludes still apply; storing the merged
 * result would freeze settings drift into the record.
 */

import type { CopyTreeOptions } from "./copyTree.js";

export const COPY_TREE_HISTORY_SCHEMA_VERSION = 1;

/**
 * Cap per project. The UI surfaces about five, so this leaves room for the
 * long tail without letting the file grow unbounded.
 */
export const COPY_TREE_HISTORY_MAX_RECORDS = 20;

/** Cap on the persisted display name, whether supplied or derived. */
export const COPY_TREE_HISTORY_NAME_MAX_LENGTH = 120;

/**
 * Which surface asked for the run. Recorded because the same options mean
 * different things from a file-browser folder menu and an agent tool call.
 *
 * `terminal` and `workflow` cover the two in-app injection paths that are
 * neither a user-facing copy button nor an agent call. `unknown` is the honest
 * answer for a caller that did not identify itself — never a stand-in for one
 * of the named surfaces.
 */
export const COPY_TREE_RUN_SOURCES = [
  "toolbar",
  "shortcut",
  "worktree-card",
  "file-browser",
  "mcp",
  "terminal",
  "workflow",
  "unknown",
] as const;

export type CopyTreeRunSource = (typeof COPY_TREE_RUN_SOURCES)[number];

/**
 * The subset of `CopyTreeResult` worth keeping. `fileCount` is always present
 * on a completed run; `totalSize` and `duration` ride on the result's optional
 * `stats`, so they are optional here too — a run that reported no stats is
 * recorded with what it did report rather than dropped or padded with zeros.
 */
export interface CopyTreeRunStats {
  fileCount: number;
  totalSize?: number;
  duration?: number;
}

export interface CopyTreeHistoryRecord {
  id: string;
  /**
   * SHA-256 over the canonicalized options alone. The name deliberately sits
   * outside it, so renaming an entry later cannot fork the history.
   */
  dedupeKey: string;
  /** Caller-supplied when given, otherwise derived from the options. */
  name: string;
  /** Exactly what the caller passed, pre-merge. */
  options: CopyTreeOptions;
  /** Surface of the most recent run. */
  source: CopyTreeRunSource;
  /** Worktree of the most recent run. */
  worktreeId: string;
  /** Stats of the most recent run. */
  stats: CopyTreeRunStats;
  /** Epoch ms of the first run with these options. */
  createdAt: number;
  /** Epoch ms of the most recent run. Drives LRU eviction. */
  lastUsedAt: number;
  /** How many runs have collapsed into this entry. */
  runCount: number;
}

/**
 * What a completed run contributes. The main process is authoritative for
 * `id`, `dedupeKey`, `createdAt`, `lastUsedAt` and `runCount` — it stamps them
 * so nothing upstream can forge history ordering.
 */
export interface CopyTreeHistoryAppendInput {
  /** Optional; blank is treated as absent. Wired by #11734. */
  name?: string;
  options: CopyTreeOptions;
  source: CopyTreeRunSource;
  worktreeId: string;
  stats: CopyTreeRunStats;
}

/** On-disk shape. `_schemaVersion` is stamped by the encoder, never accepted. */
export interface CopyTreeHistoryFile {
  _schemaVersion: number;
  /** Newest-first. */
  records: CopyTreeHistoryRecord[];
}
