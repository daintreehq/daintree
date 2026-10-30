import type { PtyPanelData, TerminalRuntimeStatus } from "@shared/types/panel";

export interface AttachedProcessState {
  spawnStatus: PtyPanelData["spawnStatus"];
  runtimeStatus: TerminalRuntimeStatus | undefined;
  isExited: boolean;
  isRestarting: boolean;
  hasSpawnError: boolean;
  hasRestartError: boolean;
  backendStatus: "connected" | "disconnected" | "recovering";
}

/**
 * Whether a pane whose display failed can still say its process is running.
 * `attachError` outlives an exit and a failed spawn (#15233), so the banner
 * only vouches for the process while nothing says it has stopped or never
 * started. A hydrated pane has no spawn status and counts as ready.
 */
export function isAttachedProcessRunning(state: AttachedProcessState): boolean {
  return (
    (state.spawnStatus ?? "ready") === "ready" &&
    !state.isExited &&
    !state.isRestarting &&
    !state.hasSpawnError &&
    !state.hasRestartError &&
    state.runtimeStatus !== "exited" &&
    state.runtimeStatus !== "error" &&
    state.backendStatus === "connected"
  );
}
