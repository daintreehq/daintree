import type { AgentState } from "@/types";

export type AmbientState = "failed" | "exited" | "paused" | "suspended" | "waiting" | null;

export interface AmbientStateInput {
  agentState?: AgentState;
  flowStatus?: "running" | "paused-backpressure" | "paused-user" | "suspended";
  isExited: boolean;
}

export function getAmbientState(input: AmbientStateInput): AmbientState {
  const { agentState, flowStatus, isExited } = input;

  if (agentState === "failed") return "failed";

  if (isExited) return "exited";

  if (flowStatus === "paused-backpressure" || flowStatus === "suspended") {
    return flowStatus === "suspended" ? "suspended" : "paused";
  }

  if (agentState === "waiting") return "waiting";

  return null;
}

export function getAmbientClassName(state: AmbientState): string | null {
  if (!state) return null;
  return `terminal-ambient-${state}`;
}
