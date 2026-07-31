/** CopyTree generation options */
export interface CopyTreeOptions {
  /** Output format */
  format?: "xml" | "json" | "markdown" | "tree" | "ndjson" | "sarif";

  /** Pattern filtering */
  filter?: string | string[];
  exclude?: string | string[];
  always?: string[];

  /** Explicit file/folder paths to include (used by file picker modal) */
  includePaths?: string[];

  /**
   * Literal worktree-relative file or directory paths to walk, used by the file
   * browser's folder context menu. Unlike `includePaths` these are not patterns
   * — nothing is escaped or globbed — and the ignore stack is still resolved
   * from the worktree root down, so a scoped run yields what a full run would
   * have yielded for that subtree, modulo the global budgets (`maxFileCount`,
   * `maxTotalSize`, `charLimit`, plus the SDK's own defaults), which are
   * recomputed over the scoped traversal. Composes with `filter`/`includePaths`
   * rather than replacing them.
   */
  scopePaths?: string[];

  /** Git filtering - only include files modified in working directory (staged + unstaged changes, excludes untracked files) */
  modified?: boolean;
  /** Git filtering - only include files changed since specified commit/branch */
  changed?: string;

  /**
   * Per-file size gate in bytes. Files above it are never opened and are
   * reported under `excluded.byReason.sizeGate`. `always` patterns override it.
   * Left unset no configurable gate applies, but CopyTree's own 10MB
   * memory-safety ceiling still does and nothing lifts that.
   */
  maxFileSize?: number;
  maxTotalSize?: number;
  maxFileCount?: number;

  /** Formatting */
  withLineNumbers?: boolean;
  /** Character budget across all file content, not per file */
  charLimit?: number;

  /** Sorting strategy for file selection when limits are exceeded */
  sort?: "path" | "size" | "modified" | "name" | "extension" | "depth";
}

export interface CopyTreeGeneratePayload {
  worktreeId: string;
  options?: CopyTreeOptions;
  /**
   * Return a bounded head of the bundle alongside the file path (#11528).
   *
   * Off by default: the bundle is written to a file and only its path comes
   * back, so a multi-MB context never crosses a process boundary. Opting in
   * never restores that — the file is still the source, and the head is read
   * back from it under a hard serialized-size budget.
   *
   * Deliberately a payload field rather than a `CopyTreeOptions` one: the
   * options object is caller-supplied over MCP and merged with persisted
   * project settings, and this is a per-call response shape, not a
   * context-generation setting.
   */
  includeContent?: boolean;
}

export interface CopyTreeGenerateAndCopyFilePayload {
  worktreeId: string;
  options?: CopyTreeOptions;
}

/** Payload for injecting CopyTree context to terminal */
export interface CopyTreeInjectPayload {
  terminalId: string;
  worktreeId: string;
  options?: CopyTreeOptions;
  /** Unique identifier for this injection operation (for per-operation cancellation) */
  injectionId?: string;
}

/** Payload for cancelling a specific injection operation */
export interface CopyTreeCancelPayload {
  /** If provided, only cancel this specific injection. If omitted, cancels all. */
  injectionId?: string;
}

/**
 * Options for the test-config dry run. `null` marks a field the user explicitly
 * cleared in the unsaved settings form — it blocks the saved-settings back-fill
 * in the main process, while `undefined`/absent still falls back. The sentinel
 * must be `null` (not `undefined`) because Electron's structured clone drops
 * `undefined`-valued keys in transit.
 */
export interface CopyTreeTestConfigOptions extends Omit<
  CopyTreeOptions,
  "exclude" | "always" | "maxFileSize" | "maxTotalSize" | "charLimit" | "sort"
> {
  exclude?: string | string[] | null;
  always?: string[] | null;
  maxFileSize?: number | null;
  maxTotalSize?: number | null;
  charLimit?: number | null;
  sort?: CopyTreeOptions["sort"] | null;
}

/** Payload for testing CopyTree configuration (dry run) */
export interface CopyTreeTestConfigPayload {
  worktreeId: string;
  options?: CopyTreeTestConfigOptions;
}

/**
 * Why a file did not make it into the context. Mirrors the SDK's stable
 * exclusion reason keys — machine-readable, never prose, and additive.
 */
export type CopyTreeExclusionReason =
  | "gitignore"
  | "copytreeignore"
  | "globalGitignore"
  | "gitInfoExclude"
  | "configExclude"
  | "optionExclude"
  | "filterPattern"
  | "testExclude"
  | "binaryExtension"
  | "sizeGate"
  | "totalSizeBudget"
  | "fileCountBudget"
  | "charBudget"
  | "scopeFilter"
  | "gitFilter"
  | "duplicate"
  | "unreadable";

/**
 * Exclusion accounting for a run. A pruned directory counts as a single
 * exclusion standing in for its whole subtree.
 */
export interface CopyTreeExclusionSummary {
  /** How many entries were excluded */
  total: number;
  /** Counts keyed by reason */
  byReason: Partial<Record<CopyTreeExclusionReason, number>>;
}

/** Which budget dropped files first */
export type CopyTreeTruncatedBy = "maxFileCount" | "maxTotalSize" | "charLimit";

/** Budget and estimate reporting shared by real runs and dry runs */
export interface CopyTreeBudgetStats {
  /**
   * Output characters. Measured on a real run, estimated on a dry run where
   * the estimate is biased high.
   */
  estimatedOutputChars?: number;
  /** Rough token count (chars/4), accurate to roughly ±20% */
  estimatedTokens?: number;
  /** True when nothing matched — a valid outcome, not an error */
  noFilesMatched?: boolean;
  /** What didn't make it, and why */
  excluded?: CopyTreeExclusionSummary;
  /** Whether a budget dropped files */
  truncated?: boolean;
  /** How many files a budget dropped or cut short */
  truncatedCount?: number;
  /** Which budget bit first — not necessarily the only one that bit */
  truncatedBy?: CopyTreeTruncatedBy;
  /**
   * The retained set is larger than `maxTotalSize`. Happens when the first file
   * alone exceeds the budget and is kept anyway, so it can be true even when
   * nothing was truncated.
   */
  budgetExceeded?: boolean;
}

/** Result from CopyTree dry run test */
export interface CopyTreeTestConfigResult extends CopyTreeBudgetStats {
  /** Number of files that would be included */
  includedFiles: number;
  /** Total size of included files in bytes */
  includedSize: number;
  /** Optional list of included file paths (for detailed preview) */
  files?: Array<{ path: string; size: number }>;
  /** Error message if dry run failed */
  error?: string;
}

/** Payload for getting file tree */
export interface CopyTreeGetFileTreePayload {
  worktreeId: string;
  /** Optional directory path relative to worktree root (defaults to root) */
  dirPath?: string;
}

/** Result from CopyTree generation */
export interface CopyTreeResult {
  /**
   * Generated content.
   *
   * Empty on every file-backed path — `generate` (which now writes a file by
   * default), `generateAndCopyFile` and `injectToTerminal` all deliver the
   * bundle somewhere other than this field and drop it rather than clone a
   * second multi-MB copy across a process boundary.
   */
  content: string;
  /** Number of files included */
  fileCount: number;
  /**
   * Absolute path of the written bundle, when generation was file-backed.
   *
   * Ephemeral: it lives in the OS temp directory and is pruned by age and by
   * count, so a consumer must read it promptly rather than store it.
   */
  filePath?: string;
  /** UTF-8 byte size of the written bundle. Present whenever `filePath` is. */
  outputBytes?: number;
  /** True when `content` holds only the head of a larger bundle. */
  contentTruncated?: boolean;
  /** Error message if generation failed */
  error?: string;
  /**
   * Version of the emitted format, e.g. `copytree-xml@1`. The output shape is a
   * compatibility surface agents are prompted against, so it is versioned.
   */
  outputFormatVersion?: string | null;
  /** Generation statistics */
  stats?: CopyTreeBudgetStats & {
    totalSize: number;
    duration: number;
  };
}

/** Progress update during CopyTree generation */
export interface CopyTreeProgress {
  /**
   * Stage label. SDK-sourced events carry a stable pipeline identifier
   * ('discover', 'load', 'format', …) and fall back to 'unknown'; the renderer
   * also synthesizes its own local states before generation starts.
   */
  stage: string;
  /** Progress percentage (0-1) */
  progress: number;
  /** Human-readable progress message */
  message: string;
  /** Optional trace ID to track event chains */
  traceId?: string;
}

/** File tree node for file picker */
export interface FileTreeNode {
  /** File/folder name */
  name: string;
  /** Relative path from worktree root */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** File size in bytes (directories have size 0) */
  size?: number;
  /** Children (only populated for directories if expanded) */
  children?: FileTreeNode[];
  /**
   * Set when the node contributes nothing to the context CopyTree would
   * generate — an excluded file, or a directory with no includable descendant.
   * Only present on the context listing, and only when the caller opted in with
   * `includeExcluded`; the default listing omits these nodes entirely.
   *
   * There is deliberately no per-node reason. CopyTree 0.16's manifest records
   * only what survived, so an excluded path has no entry to read a reason from,
   * and `stats.excluded.largest` is capped at 50 and ordered by size — pruned
   * directories report size 0 and fall off the list first, which is exactly the
   * case a picker most needs an answer for.
   */
  excluded?: boolean;
}
