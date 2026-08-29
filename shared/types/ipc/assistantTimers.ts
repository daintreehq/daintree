import type { AssistantTimerRow, AssistantTimerOutcomeRow } from "./assistantHost.js";

/**
 * The DETACHED timer route's IPC shapes.
 *
 * Separate from `assistantHost.ts` because they describe a different transport
 * answering the same question: the panel asks its own engine over the host protocol,
 * and this asks the supervisor daemon that outlives it. They deliberately reuse the
 * host's ROW types — one shape reaches the renderer whichever route replied, so a
 * timer manager cannot grow two rendering paths that drift apart.
 *
 * They live in `shared/` rather than beside the Electron service because the
 * generated IPC map references them, and that map is built for both processes.
 */

export interface ProjectTimersResult {
  /**
   * Whether a supervisor could be asked at all.
   *
   * The distinction the whole surface rests on: `false` means nobody answered, which
   * is NOT "nothing is scheduled". A project with no daemon usually has no pending
   * work — but it can also be one whose daemon has not started, and telling a user
   * their overnight timer is gone because a socket was missing is the failure this
   * field exists to prevent.
   */
  available: boolean;
  timers: AssistantTimerRow[];
  outcomes: AssistantTimerOutcomeRow[];
  takenAt: number;
  /** Why nothing could be read, when `available` is false. */
  reason?: string;
}

/** What a detached cancel actually did. Mirrors the host protocol's outcome. */
export interface DaemonTimerCancelResult {
  timerId: string;
  cancelled: boolean;
  alreadyInactive: boolean;
  priorStatus: string;
  revokedGrants: number;
  grantRevokeFailed: boolean;
  /**
   * The scheduler fired the timer out from under the cancel and it is live again —
   * nothing was retired, and the honest answer is "try again".
   */
  contended: boolean;
}
