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
  /**
   * Opt-in exit snapshot: a bounded, ANSI-stripped, secret-scrubbed tail of the
   * agent terminal's output captured at close (#10850). Present only when the
   * global `terminalConfig.exitSnapshotEnabled` toggle is on and the project is
   * not excluded. Deliberately a short tail (not a full transcript) — see
   * `electron/services/pty/exitSnapshot.ts` for the size cap and scrub ordering.
   */
  snapshot?: string;
}
