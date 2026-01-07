/** CopyTree generation options */
export interface CopyTreeOptions {
  /** Output format */
  format?: "xml" | "json" | "markdown" | "tree" | "ndjson";

  /** Pattern filtering */
  filter?: string | string[];
  exclude?: string | string[];
  always?: string[];

  /** Explicit file/folder paths to include (used by file picker modal) */
  includePaths?: string[];

  /** Git filtering - only include files modified in working directory (staged + unstaged changes, excludes untracked files) */
  modified?: boolean;
  /** Git filtering - only include files changed since specified commit/branch */
  changed?: string;

  /** Size limits */
  maxFileSize?: number;
  maxTotalSize?: number;
  maxFileCount?: number;

  /** Formatting */
  withLineNumbers?: boolean;
  charLimit?: number;
}

export interface CopyTreeGeneratePayload {
  worktreeId: string;
  options?: CopyTreeOptions;
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

/** Payload for getting file tree */
export interface CopyTreeGetFileTreePayload {
  worktreeId: string;
  /** Optional directory path relative to worktree root (defaults to root) */
  dirPath?: string;
}

/** Result from CopyTree generation */
export interface CopyTreeResult {
  /** Generated content */
  content: string;
  /** Number of files included */
  fileCount: number;
  /** Error message if generation failed */
  error?: string;
  /** Generation statistics */
  stats?: {
    totalSize: number;
    duration: number;
  };
}

/** Progress update during CopyTree generation */
export interface CopyTreeProgress {
  /** Current stage name (e.g., 'FileDiscoveryStage', 'FormatterStage') */
  stage: string;
  /** Progress percentage (0-1) */
  progress: number;
  /** Human-readable progress message */
  message: string;
  /** Files processed so far (if known) */
  filesProcessed?: number;
  /** Total files estimated (if known) */
  totalFiles?: number;
  /** Current file being processed (if known) */
  currentFile?: string;
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
}
