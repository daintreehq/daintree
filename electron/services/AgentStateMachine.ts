import type { AgentState } from "../types/index.js";

export type AgentEvent =
  | { type: "start" }
  | { type: "output"; data: string }
  | { type: "busy" } // Agent is actively receiving data
  | { type: "prompt" } // Agent has been idle (no data for debounce period)
  | { type: "input" } // User input received
  | { type: "exit"; code: number }
  | { type: "error"; error: string };

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["working", "running", "failed"],
  working: ["waiting", "completed", "failed"],
  running: ["idle"], // Shell process state - managed by TerminalProcess, not this state machine
  waiting: ["working", "failed"],
  completed: ["failed"], // Allow error events to override completed state
  failed: ["failed"],
};

export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function nextAgentState(current: AgentState, event: AgentEvent): AgentState {
  if (event.type === "error") {
    return "failed";
  }

  switch (event.type) {
    case "start":
      if (current === "idle") {
        return "working";
      }
      break;

    case "busy":
      // Handles re-entry to working from waiting state when agent resumes activity
      if (current === "waiting" || current === "idle") {
        return "working";
      }
      break;

    case "output":
      // Output events no longer trigger state changes - activity is handled by ActivityMonitor
      break;

    case "prompt":
      // Activity monitor detected silence - transition to waiting
      if (current === "working") {
        return "waiting";
      }
      break;

    case "input":
      if (current === "waiting" || current === "idle") {
        return "working";
      }
      break;

    case "exit":
      if (current === "working" || current === "waiting") {
        return event.code === 0 ? "completed" : "failed";
      }
      break;
  }

  return current;
}

export function getStateChangeTimestamp(): number {
  return Date.now();
}
