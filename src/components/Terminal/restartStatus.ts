import type { PanelExitBehavior } from "@shared/types/panel";
import type { TerminalRestartError } from "@/types";

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
}

export function getRestartBannerVariant(input: RestartBannerInput): RestartBannerVariant {
  if (input.isAutoRestarting) {
    return { type: "auto-restarting" };
  }

  if (
    input.isExited &&
    input.exitCode !== null &&
    input.exitCode !== 0 &&
    input.exitCode !== 130 &&
    !input.dismissedRestartPrompt &&
    !input.restartError &&
    !input.isRestarting &&
    input.exitBehavior !== "restart"
  ) {
    return { type: "exit-error", exitCode: input.exitCode };
  }

  return { type: "none" };
}
