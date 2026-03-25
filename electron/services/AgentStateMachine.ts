import type { AgentState } from "../types/index.js";

export type AgentEvent =
  | { type: "start" }
  | { type: "output"; data: string }
  | { type: "busy" } // Agent is actively receiving data
  | { type: "prompt" } // Agent has been idle (no data for debounce period)
  | { type: "completion" } // Agent completed a task (pattern-detected)
  | { type: "input" } // User input received
  | { type: "exit"; code: number; signal?: number }
  | { type: "error"; error: string }
  | { type: "kill" }; // Intentional kill by user

const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["working", "running"],
  working: ["waiting", "completed"],
  running: ["idle"], // Shell process state - managed by TerminalProcess, not this state machine
  waiting: ["working"],
  directing: [], // Renderer-only state, never produced by main process
  completed: ["working", "waiting"],
};

export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function nextAgentState(current: AgentState, event: AgentEvent): AgentState {
  // Error events are no-ops
  if (event.type === "error") {
    return current;
  }

  if (event.type === "kill") {
    return "idle";
  }

  switch (event.type) {
    case "start":
      if (current === "idle") {
        return "working";
      }
      break;

    case "busy":
      // Handles re-entry to working from waiting/idle/completed states when agent resumes activity
      if (current === "waiting" || current === "idle" || current === "completed") {
        return "working";
      }
      break;

    case "output":
      // Output events no longer trigger state changes - activity is handled by ActivityMonitor
      break;

    case "completion":
      if (current === "working") {
        return "completed";
      }
      break;

    case "prompt":
      // Activity monitor detected silence - transition to waiting
      if (current === "working" || current === "completed") {
        return "waiting";
      }
      break;

    case "input":
      if (current === "waiting" || current === "idle" || current === "completed") {
        return "working";
      }
      break;

    case "exit":
      if (current === "working" || current === "waiting" || current === "completed") {
        return "completed";
      }
      break;
  }

  return current;
}

export function getStateChangeTimestamp(): number {
  return Date.now();
}
