/**
 * Canonical agent finite-state machine, shared between the main process
 * (`electron/services/AgentStateMachine.ts`) and the renderer Web Worker
 * (`src/workers/WorkerAgentStateService.ts`).
 *
 * Browser-safe: no Node or DOM imports.
 */

import type { AgentState } from "../types/agent.js";

export type AgentEvent =
  | { type: "start" }
  | { type: "output"; data: string }
  | { type: "busy" } // Agent is actively receiving data
  | { type: "prompt" } // Agent has been idle (no data for debounce period)
  | { type: "completion" } // Agent completed a task (pattern-detected)
  | { type: "input" } // User input received
  | { type: "exit"; code: number; signal?: number }
  | { type: "error"; error: string }
  | { type: "kill" } // Intentional kill by user
  | { type: "respawn" } // New agent session detected in same PTY after a prior exit
  | { type: "watchdog-timeout" }; // Watchdog: waiting state timed out with dead children

// Natural-lifecycle transitions — the set of state changes produced by ordinary
// agent events (start/busy/prompt/completion/input/exit/respawn/watchdog-timeout).
// `kill` is a hard-reset override that bypasses this table by design and
// returns to `idle` from any state, so `kill`-driven transitions are
// intentionally NOT enumerated here.
export const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["working", "exited"],
  working: ["waiting", "completed", "exited"],
  waiting: ["working", "completed", "exited", "idle"],
  directing: [], // Renderer-only state, never produced by main process.
  completed: ["working", "waiting", "exited"],
  exited: ["idle"], // Terminal per agent lifecycle; `respawn` allows a fresh agent session in the same PTY.
};

export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function nextAgentState(current: AgentState, event: AgentEvent): AgentState {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return current;
  }

  if (event.type === "exit" && typeof event.code !== "number") {
    return current;
  }

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
      if (current !== "exited") {
        return "exited";
      }
      break;

    case "respawn":
      if (current === "exited") {
        return "idle";
      }
      break;

    case "watchdog-timeout":
      if (current === "waiting") {
        return "idle";
      }
      break;
  }

  return current;
}
