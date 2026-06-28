import type { PanelExitBehavior } from "@shared/types/panel";
import type { TerminalRestartError, SpawnError, TerminalReconnectError } from "@/types";
import type { BackendStatus } from "@/store/panelStore";

export type RestartBannerVariant =
  | { type: "auto-restarting" }
  | { type: "restarting" }
  | { type: "session-resume-unavailable" }
  | { type: "exit-error"; exitCode: number }
  | { type: "none" };

export interface RestartBannerInput {
  isExited: boolean;
  exitCode: number | null;
  dismissedRestartPrompt: boolean;
  restartError: TerminalRestartError | undefined;
  isRestarting: boolean;
  isAutoRestarting: boolean;
  exitBehavior: PanelExitBehavior | undefined;
  reconnectError?: TerminalReconnectError;
  spawnError?: SpawnError;
  backendStatus: BackendStatus;
  /** True when restore fell through to a fresh agent launch (issue #9802). */
  sessionLostOnRestore?: boolean;
  /**
   * True once the user dismissed the session-resume-unavailable banner
   * (issue #10823). Tracked separately from `dismissedRestartPrompt` so
   * acknowledging a lost session never suppresses a later exit-error banner
   * for a crash of the fresh session.
   */
  dismissedSessionLost?: boolean;
}

export function getRestartBannerVariant(input: RestartBannerInput): RestartBannerVariant {
  if (input.isAutoRestarting && !input.restartError && !input.reconnectError && !input.spawnError) {
    return { type: "auto-restarting" };
  }

  if (
    input.isRestarting &&
    !input.isAutoRestarting &&
    !input.restartError &&
    !input.reconnectError &&
    !input.spawnError
  ) {
    return { type: "restarting" };
  }

  // The previous agent session couldn't be resumed and restore fell through to a
  // fresh launch. Surface it so the user isn't silently dropped into a clean
  // session (issue #9802). Gated below the in-flight restart states (a live
  // restart takes precedence) and above exit-error so a lost session is
  // acknowledged before any prior exit prompt. Dismissable (issue #10823): the
  // user recovers just by carrying on in the fresh session, so once they
  // acknowledge it the banner stays gone for this session. Uses a dedicated
  // `dismissedSessionLost` flag — not `dismissedRestartPrompt` — so dismissing
  // this acknowledgement never suppresses a later exit-error for the fresh
  // session crashing.
  if (
    input.sessionLostOnRestore &&
    !input.dismissedSessionLost &&
    !input.isRestarting &&
    !input.isAutoRestarting &&
    !input.restartError &&
    !input.reconnectError &&
    !input.spawnError
  ) {
    return { type: "session-resume-unavailable" };
  }

  if (
    input.backendStatus === "connected" &&
    input.isExited &&
    input.exitCode !== null &&
    input.exitCode !== 0 &&
    input.exitCode !== 130 &&
    !input.dismissedRestartPrompt &&
    !input.restartError &&
    !input.reconnectError &&
    !input.spawnError &&
    !input.isRestarting &&
    input.exitBehavior !== "restart"
  ) {
    return { type: "exit-error", exitCode: input.exitCode };
  }

  return { type: "none" };
}
