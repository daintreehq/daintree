import type { AgentState } from "../agent.js";
import type { AgentDirectorySubject } from "../agentDirectory.js";

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

/** Rows a past-sessions listing holds at most. Older conversations stay resumable through `/resume`. */
export const HELP_PAST_SESSIONS_LIMIT = 50;

/**
 * The answer to `help:list-past-sessions` when asked with `{ listing: true }`
 * (#14984). The rows alone can't say whether they are the whole history, so
 * the listing carries what it left out.
 */
export interface HelpPastSessionsListing {
  /** Newest first, at most `HELP_PAST_SESSIONS_LIMIT`. */
  sessions: HelpPastSession[];
  /** Stores that hold this project's history but couldn't be read: their rows may be missing. */
  unreadable: HelpPastSession["agentId"][];
  /** More conversations exist than `sessions` holds; the oldest were left out. */
  truncated: boolean;
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

export type GlobalAssistantPhase = "absent" | "launching" | "running";

export interface GlobalAssistantAttachmentInfo {
  attachmentId: string;
  windowId: number;
}

/**
 * What a window may know of the installation's global assistant (#14159).
 * Never the bearer, the command line or the environment.
 */
export interface GlobalAssistantState {
  phase: GlobalAssistantPhase;
  /** Bumps with every run, so a panel can tell a new session from the one it showed. */
  generation: number;
  agentId: string | null;
  terminalId: string | null;
  attachments: GlobalAssistantAttachmentInfo[];
  /** The attachment whose input is accepted, or null when nobody holds it. */
  inputOwner: string | null;
  /** Bumps whenever the input owner changes; a write quotes the epoch it held. */
  inputEpoch: number;
}

/**
 * The global assistant as a window is told it: the lifecycle, and while it
 * runs, the exact subject — terminal and PTY launch generation — a view watches
 * it by. A subject that no longer matches is a run that ended or was replaced.
 */
export interface GlobalAssistantView extends GlobalAssistantState {
  subject: AgentDirectorySubject | null;
  /**
   * What was last seen on that subject's terminal, observed without attaching,
   * so a window can mark the run while it shows something else. Null while
   * nothing has been seen on this exact subject.
   */
  agentState: AgentState | null;
}

/**
 * The input ownership a window held when it opened its view of the global
 * session. Input through that view is accepted only while the very same
 * ownership stands: once input moves, even back to this window, the view is
 * read-only and anything still queued through it is refused.
 */
export interface GlobalAssistantInputStamp {
  attachmentId: string;
  inputEpoch: number;
}

/**
 * Whether a window's Assistant panel was last showing the global assistant
 * (#16099), and the exact run it was pinned to. Held by main per window and
 * never persisted: a window switching project hands it to the view it switches
 * to, and an app boot starts without one.
 */
export interface WindowGlobalAssistantPanel {
  showing: boolean;
  target: AgentDirectorySubject | null;
}

/** A window's reader on the global assistant, and the input epoch it holds. */
export interface GlobalAssistantAttachment {
  attachmentId: string;
  state: GlobalAssistantView;
}
