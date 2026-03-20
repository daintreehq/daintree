import type { AgentState } from "../types/index.js";
import { isRoutineExit } from "./pty/terminalForensics.js";

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
  idle: ["working", "running", "failed"],
  working: ["waiting", "completed", "failed"],
  running: ["idle"], // Shell process state - managed by TerminalProcess, not this state machine
  waiting: ["working", "failed"],
  directing: [], // Renderer-only state, never produced by main process
  completed: ["working", "waiting", "failed"], // Allow resuming work, prompt, or error override
  failed: ["failed", "working", "idle", "waiting", "completed"],
};

export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function nextAgentState(current: AgentState, event: AgentEvent): AgentState {
  if (event.type === "error") {
    return "failed";
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
      // Handles re-entry to working from waiting/idle/completed/failed states when agent resumes activity
      if (
        current === "waiting" ||
        current === "idle" ||
        current === "completed" ||
        current === "failed"
      ) {
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
      if (current === "working" || current === "completed" || current === "failed") {
        return "waiting";
      }
      break;

    case "input":
      if (
        current === "waiting" ||
        current === "idle" ||
        current === "completed" ||
        current === "failed"
      ) {
        return "working";
      }
      break;

    case "exit":
      if (current === "working" || current === "waiting") {
        return isRoutineExit(event.code, event.signal) ? "completed" : "failed";
      }
      if (current === "completed") {
        return isRoutineExit(event.code, event.signal) ? "completed" : "failed";
      }
      break;
  }

  return current;
}

export function getStateChangeTimestamp(): number {
  return Date.now();
}
