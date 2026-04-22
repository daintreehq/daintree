import type { PanelExitBehavior } from "@shared/types/panel";
import type { TerminalRestartError } from "@/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";

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

export type DegradedBannerVariant =
  | { type: "degraded-mode"; agentId: BuiltInAgentId }
  | { type: "none" };

export interface DegradedBannerInput {
  // Persisted agentId set at spawn (or after a "Restart as Agent" convert).
  // When defined, the PTY was spawned with agent env/scrollback and is not
  // in degraded mode. When undefined, the panel was spawned as a plain
  // terminal — runtime agent detection cannot repair the sealed PTY env.
  spawnAgentId: BuiltInAgentId | string | undefined;
  everDetectedAgent: boolean | undefined;
  detectedAgentId: BuiltInAgentId | undefined;
  dismissedDegradedBanner: boolean;
  isExited: boolean;
  isRestarting: boolean;
}

// Spawn-sealed promotion: a panel spawned without an agentId inherits a
// non-agent PTY (default scrollback, pool-stripped env, missing FORCE_COLOR
// etc.) — those cannot be repaired in-process for the running child, so the
// banner offers a one-click restart that respawns with an agentId.
export function getDegradedBannerVariant(input: DegradedBannerInput): DegradedBannerVariant {
  if (input.spawnAgentId !== undefined) return { type: "none" };
  if (input.everDetectedAgent !== true) return { type: "none" };
  if (!input.detectedAgentId) return { type: "none" };
  if (input.dismissedDegradedBanner) return { type: "none" };
  if (input.isExited) return { type: "none" };
  if (input.isRestarting) return { type: "none" };
  return { type: "degraded-mode", agentId: input.detectedAgentId };
}
