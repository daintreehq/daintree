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

/**
 * A running assistant a remote view took over from a view that went away
 * (#13360). Its PTY never stopped, so the view reconnects a pane to it rather
 * than launching. Display fields only: no bearer, environment or command line.
 */
export interface HelpAdoptedLane {
  sessionId: string;
  terminalId: string;
  agentId: string;
  cwd: string | null;
  title: string | null;
  agentState: string | null;
  waitingReason: string | null;
  lastStateChange: number | null;
  cols: number | null;
  rows: number | null;
}

/**
 * The answer to `help:adopt-detached-session`. `absent`: no running assistant
 * holds the lane. `occupied`: one does, attached to another view; a launch
 * that may only restore must stand down rather than displace it.
 */
export type HelpAdoptResult =
  { status: "adopted"; lane: HelpAdoptedLane } | { status: "absent" } | { status: "occupied" };
