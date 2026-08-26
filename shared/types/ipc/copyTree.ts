import type { CopyTreeRunSource } from "./copyTreeHistory.js";

/** CopyTree generation options */
export interface CopyTreeOptions {
  /** Output format */
  format?: "xml" | "json" | "markdown" | "tree" | "ndjson" | "sarif";

  /** Pattern filtering */
  filter?: string | string[];
  exclude?: string | string[];
  always?: string[];

  /**
   * Worktree-relative file paths or glob patterns to include (used by the file
   * picker modal). Unioned into the SDK's single `filter`, which matches against
   * FILE paths — so a bare directory name matches nothing. A folder needs a glob
   * (`src/panels/**`), or belongs in `scopePaths` below.
   */
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

  /**
   * Let `scopePaths` into subtrees an ignore file would have pruned (#11750).
   *
   * Absent or `false` is the default every existing caller keeps: a scoped copy
   * returns what a whole-worktree copy would have returned for that subtree.
   * `true` requires `scopePaths` and is rejected without it at both option
   * schemas — the flag is scope-bound, so accepting it alone would silently do
   * nothing, which is the failure mode the issue was filed about.
   *
   * The lift is surgical, and only the SDK's ignore-FILE escape is used: the
   * rules removed are the ones standing between the worktree root and each
   * scope entry, in the `.gitignore` and `.copytreeignore` layers only. Every
   * unrelated rule in those same files survives, negations survive, and ignore
   * files at or below the selection still apply — they describe the subtree the
   * caller asked for. Project and config exclusions (`node_modules`), the
   * caller's own `exclude`, `.git`, the git filters, the per-file size gate and
   * every budget are untouched, because the companion `scopeIgnoresConfigExcludes`
   * escape stays off.
   *
   * It cannot be narrowed to `.copytreeignore` alone: the SDK layers that file
   * at every depth on every code path, with no option or config key to drop it
   * (`FileDiscoveryStage`, copytree 0.17.0). Lifting the ignore-file rules
   * blocking a named subtree is the closest thing it does expose, and unlike
   * `always` it leaves every other exclusion layer standing.
   */
  scopeIgnoresIgnoreFiles?: boolean;

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
  /**
   * Caller-supplied display label for the run, shown in the project's
   * copy-tree history and in the completion notification (#11734).
   *
   * Deliberately a payload field rather than a `CopyTreeOptions` one, for the
   * same reason as `source`: it names the run for a human, it does not select
   * or format anything, so it must stay out of the dedupe key — two runs that
   * build the identical bundle are one history entry whatever they were
   * called. Blank counts as absent, and an absent name falls back to a label
   * derived from the options.
   */
  name?: string;
  /**
   * Which surface asked for the run, recorded in the project's copy-tree
   * history (#11732).
   *
   * Optional, and never part of the dedupe key: it describes the caller, not
   * the context to build, so omitting it changes nothing about the bundle. A
   * caller that doesn't identify itself is recorded as `unknown` rather than
   * being attributed to a surface it didn't come from.
   */
  source?: CopyTreeRunSource;
}

export interface CopyTreeGenerateAndCopyFilePayload {
  worktreeId: string;
  options?: CopyTreeOptions;
  /** See {@link CopyTreeGeneratePayload.name}. */
  name?: string;
  /** See {@link CopyTreeGeneratePayload.source}. */
  source?: CopyTreeRunSource;
}

/** Payload for injecting CopyTree context to terminal */
export interface CopyTreeInjectPayload {
  terminalId: string;
  worktreeId: string;
  options?: CopyTreeOptions;
  /** Unique identifier for this injection operation (for per-operation cancellation) */
  injectionId?: string;
  /** See {@link CopyTreeGeneratePayload.name}. */
  name?: string;
  /** See {@link CopyTreeGeneratePayload.source}. */
  source?: CopyTreeRunSource;
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

/**
 * Which pattern selector a caller supplied, named the way the caller spelled it.
 *
 * `filter` and `includePaths` are unioned into the SDK's single `filter` before
 * it runs, so once a run is over the two can no longer be told apart from its
 * stats — which is why supplying both reports the pair rather than guessing.
 *
 * A tuple rather than a bare union: `CopyTreeStatsSchema` builds its `z.enum`
 * from this, so the wire enum and this type cannot drift. Dispatch parses
 * results against that schema (#11539), and a member here that the enum lacked
 * would fail the parse and take the whole result down with it.
 */
export const COPY_TREE_UNMATCHED_SELECTORS = [
  "filter",
  "includePaths",
  "filterAndIncludePaths",
] as const;

export type CopyTreeUnmatchedSelector = (typeof COPY_TREE_UNMATCHED_SELECTORS)[number];

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
  /**
   * Which supplied pattern selector emptied the run, when one did.
   *
   * `noFilesMatched` alone says nothing about WHICH selector missed, so a caller
   * that passed a bare directory to `includePaths` learns only that it got
   * nothing and is left guessing at the option shape (#11731).
   *
   * Set only when the run came back empty, files reached the pattern check and
   * were rejected there, and NOTHING was removed after the patterns ran. That
   * last condition is what keeps the hint honest: `noFilesMatched` is measured
   * once the whole pipeline is done, and the git filter, the budgets and the
   * size gate all run later — so a single file removed by one of those is proof
   * the patterns matched it, and the patterns are not what emptied the run. An
   * empty scope, an empty repo, a `modified` filter with no changes and a
   * budget that dropped the last file therefore all leave this unset.
   *
   * Ignore rules, configured excludes and scope prune while the walker
   * descends, before the patterns are consulted, so they neither set nor
   * suppress this.
   */
  unmatchedSelector?: CopyTreeUnmatchedSelector;
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

/**
 * What a listed symbolic link points at (#11939).
 *
 * Windows junctions are covered by the same shape with no special-casing: a
 * `Dirent` reports `isSymbolicLink()` true and `isDirectory()` false for both a
 * junction and a directory symlink, and nothing short of reading the target's
 * NT-namespace prefix tells them apart — so nothing here tries to.
 */
export interface FileTreeSymlink {
  /**
   * Absolute path the link points at, resolved the way the kernel resolves it
   * — against the canonical directory the entry was listed from, since a raw
   * target like `../acorn/bin/acorn` is relative to where the link lives. That
   * matters when the listed directory is itself reached through a link: the
   * lexical parent and the real parent are different directories, and only the
   * second one gives the target the OS would actually open.
   */
  target: string;
  /**
   * What the target turned out to be, and the single field the browser reads
   * to decide what a link row can do.
   *
   * `"file"` and `"directory"` are the resolved, contained cases — the only
   * two where `isDirectory` reflects the target and descent is allowed.
   * `"broken"` is a target that does not exist. `"external"` is a target that
   * resolves outside the workspace root. `"unknown"` is a target that could
   * not be classified at all (a symlink loop, permission denied) — kept
   * distinct from `"external"` so the UI never tells someone a link points
   * outside their workspace when the truth is that it could not be read.
   *
   * There is deliberately no separate "may I descend" flag. It would be fully
   * derivable from this one, and two fields that must agree are two fields
   * that can disagree.
   */
  targetKind: "file" | "directory" | "broken" | "external" | "unknown";
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
  /**
   * Last-modified time in epoch milliseconds, read off the `lstat` the listing
   * already performs — never its own syscall.
   *
   * Absent on nodes that did not come from a live directory read: a tree
   * rehydrated from a persisted snapshot stores structure only, so every
   * consumer needs an answer for "unknown" rather than treating it as 0. It
   * does reach the CopyTree context listing, which applies its include/exclude
   * verdict to the raw listing nodes rather than rebuilding them — the same
   * route `size` already travels.
   */
  mtimeMs?: number;
  /** Children (only populated for directories if expanded) */
  children?: FileTreeNode[];
  /**
   * Present only on symbolic links (#11939). Absence means the entry is a
   * plain file or directory, which is why every consumer can keep reading
   * `isDirectory` and ignore this field entirely.
   *
   * `isDirectory` is true for a link only when `targetKind` is `"directory"`,
   * so a consumer routing on `isDirectory` alone — the CopyTree verdict
   * overlay, the tree's chevron, the expansion fetch — stays correct without
   * ever reading this field.
   *
   * Not carried by the persisted tree snapshot, which stores structure only —
   * a restored out-of-root link comes back as `isDirectory: false` and is
   * therefore still non-descendable, and its decoration returns as soon as the
   * live listing lands.
   */
  symlink?: FileTreeSymlink;
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
