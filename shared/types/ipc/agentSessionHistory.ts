import type { PanelTitleMode } from "../panel.js";

/**
 * User-adjustable retention window for the agent resume journal, in days.
 * `0` means "keep forever" — records are never evicted by age (the per-worktree
 * cap still applies). Bookmarked records (see {@link AgentSessionBookmarkMetadata})
 * are exempt from BOTH the age window and the per-worktree cap regardless of
 * this setting; only ordinary, unbookmarked history is pruned.
 */
export type AgentSessionRetentionDays = 7 | 30 | 90 | 0;

/**
 * Intentional, durable bookmark metadata attached to an {@link AgentSessionRecord}.
 * A bookmark pins a resumable conversation so it survives history retention and
 * the per-worktree cap until the user explicitly deletes it. This is additive
 * metadata only — the record's existing top-level fields remain the resume
 * authority. It stores NO terminal output, transcript text, prompt content, or
 * environment values (see the feature spec's privacy boundary); only the
 * bounded label plus pane-presentation hints needed to reconstruct the pane.
 */
export interface AgentSessionBookmarkMetadata {
  /** Epoch ms the bookmark was first created. Preserved across re-journaling. */
  bookmarkedAt: number;
  /** User-recognizable name, trimmed to 1–120 chars. The durable retrieval key. */
  label: string;
  /** Panel id the bookmark was captured from, for diagnostics only. */
  sourcePanelId?: string;
  /**
   * Where the source pane lived at capture time. Narrower than `PanelLocation`
   * on purpose: overlays, trash, background, and dialogs are never valid
   * bookmark sources.
   */
  sourceLocation?: "grid" | "dock";
  /** Title-ownership mode of the source pane, restored on resume (Phase 2). */
  titleMode?: PanelTitleMode;
  /** Resolved agent preset id at capture time. */
  agentPresetId?: string;
  /** Preset accent color at capture time, restored on resume (Phase 2). */
  agentPresetColor?: string;
  /** Preset originally requested (may differ from `agentPresetId` under fallback). */
  originalPresetId?: string;
  /** Whether the pane was running under a fallback agent at capture time. */
  isUsingFallback?: boolean;
  /** Index into the fallback chain when `isUsingFallback` is true. */
  fallbackChainIndex?: number;
  /** Whether the pane's input was locked at capture time. */
  isInputLocked?: boolean;
}

export interface AgentSessionRecord {
  sessionId: string;
  agentId: string;
  worktreeId: string | null;
  title: string | null;
  projectId: string | null;
  savedAt: number;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  /** Working directory the terminal was running in at capture time. */
  cwd?: string;
  /** Git branch checked out in `cwd` at capture time, for resume sanity checks. */
  branch?: string;
  /**
   * Present when the user has intentionally pinned this session. A record with a
   * `bookmark` is exempt from age pruning and the per-worktree history cap; a
   * record without one is ordinary, time-limited history. See
   * {@link AgentSessionBookmarkMetadata}.
   */
  bookmark?: AgentSessionBookmarkMetadata;
}
