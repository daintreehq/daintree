import type { PanelExitBehavior } from "@shared/types/panel";
import type { TerminalRestartError, SpawnError, TerminalReconnectError } from "@/types";
import type { BackendStatus } from "@/store/panelStore";

export type RestartBannerVariant =
  | { type: "auto-restarting" }
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
}

export function getRestartBannerVariant(input: RestartBannerInput): RestartBannerVariant {
  if (input.isAutoRestarting && !input.restartError && !input.reconnectError && !input.spawnError) {
    return { type: "auto-restarting" };
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
