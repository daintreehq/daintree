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
