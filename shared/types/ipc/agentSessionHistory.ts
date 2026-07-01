/**
 * User-adjustable retention window for the agent resume journal, in days.
 * `0` means "keep forever" — records are never evicted by age (the per-worktree
 * cap still applies).
 */
export type AgentSessionRetentionDays = 7 | 30 | 90 | 0;

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
}
