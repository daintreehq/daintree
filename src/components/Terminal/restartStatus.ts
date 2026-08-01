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
  /**
   * True when restore fell through to a fresh agent launch and the user hasn't
   * acknowledged it yet (issue #9802). Dismissing the banner clears the flag in
   * the panel store (issue #11589), so this doubles as the "not yet dismissed"
   * gate — there is deliberately no separate dismissal flag to fall out of sync
   * with it. Kept independent of `dismissedRestartPrompt` so acknowledging a
   * lost session never suppresses a later exit-error banner for a crash of the
   * fresh session (issue #10823).
   */
  sessionLostOnRestore?: boolean;
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
  // acknowledge it the banner stays gone for this session. Dismissal clears
  // `sessionLostOnRestore` itself in the panel store (issue #11589) — it never
  // touches `dismissedRestartPrompt`, so acknowledging a lost session still
  // can't suppress a later exit-error for the fresh session crashing.
  if (
    input.sessionLostOnRestore &&
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
