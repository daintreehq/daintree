/**
 * Narrow, display-only projection of the `ActionContext` snapshot pinned to a
 * help session at provision time (#8772). Returned by
 * `help:get-pinned-action-context` so the HelpPanel footer can show which
 * worktree/terminal the assistant's tool calls are bound to. Deliberately
 * excludes the bearer token and runtime-only fields (`dispatchSource`, etc.) —
 * only the fields the footer chip renders are exposed across the bridge.
 */
export interface PinnedActionContextSnapshot {
  worktreeId: string | null;
  worktreeName: string | null;
  worktreeBranch: string | null;
  terminalId: string | null;
}

/**
 * One past assistant conversation for a project (#13206): a transcript the
 * agent itself recorded under the project's shared help-sessions directory.
 * `title` is conversation text — rendered in the picker, never logged.
 */
export interface HelpPastSession {
  agentId: "claude" | "codex";
  /** The id `buildResumeCommand` resumes — exact, never "latest". */
  sessionId: string;
  title: string;
  /** Epoch ms of the last activity the store recorded. */
  updatedAt: number;
}
