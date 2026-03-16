import type { AgentState } from "@/types";
import type { ManagedTerminal } from "./types";
import { useTerminalStore } from "@/store/terminalStore";
import { logError } from "@/utils/logger";

export interface AgentStateControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
}

const DIRECTING_DEBOUNCE_MS = 2500;

export class TerminalAgentStateController {
  private directingTimers = new Map<string, number>();
  private deps: AgentStateControllerDeps;

  constructor(deps: AgentStateControllerDeps) {
    this.deps = deps;
  }

  setAgentState(id: string, state: AgentState): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (state === "directing") return;

    managed.canonicalAgentState = state;

    if (state !== "waiting") {
      this.clearDirectingState(id);
    }

    const previousState = managed.agentState;
    if (previousState === state) return;

    if (previousState === "directing" && state === "waiting") return;

    managed.agentState = state;

    this.notifySubscribers(managed, state);
  }

  onUserInput(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.kind === "agent" && managed.canonicalAgentState === "waiting") {
      if (managed.agentState !== "directing") {
        managed.agentState = "directing";
        this.notifySubscribers(managed, "directing");
        useTerminalStore.getState().updateAgentState(id, "directing");
      }

      const existingTimer = this.directingTimers.get(id);
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
      }
      this.directingTimers.set(
        id,
        window.setTimeout(() => {
          this.clearDirectingState(id);
        }, DIRECTING_DEBOUNCE_MS)
      );
    }
  }

  clearDirectingState(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || managed.agentState !== "directing") return;

    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }

    const revertState = managed.canonicalAgentState ?? "waiting";
    managed.agentState = revertState;

    this.notifySubscribers(managed, revertState);
    useTerminalStore.getState().updateAgentState(id, revertState);
  }

  destroy(id: string): void {
    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }
  }

  dispose(): void {
    for (const timer of this.directingTimers.values()) {
      clearTimeout(timer);
    }
    this.directingTimers.clear();
  }

  private notifySubscribers(managed: ManagedTerminal, state: AgentState): void {
    for (const callback of managed.agentStateSubscribers) {
      try {
        callback(state);
      } catch (err) {
        logError("Agent state callback error", err);
      }
    }
  }
}
