import type { AgentState } from "@/types";
import type { ManagedTerminal } from "./types";
import { useTerminalStore } from "@/store/terminalStore";
import { logError } from "@/utils/logger";

export interface AgentStateControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
}

const DIRECTING_DEBOUNCE_SHORT_MS = 1500;
const DIRECTING_DEBOUNCE_LONG_MS = 10000;
const DIRECTING_PHASE2_THRESHOLD = 5;

export class TerminalAgentStateController {
  private directingTimers = new Map<string, number>();
  private compositionCounts = new Map<string, number>();
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

  onUserInput(id: string, data: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.kind === "agent" && managed.canonicalAgentState === "waiting") {
      if (managed.agentState === "working") return;

      const count = this.compositionCounts.get(id) ?? 0;
      let newCount: number;
      let debounceCount: number;
      if (data === "") {
        newCount = count;
        debounceCount = count;
      } else if (data === "\x7f") {
        newCount = Math.max(0, count - 1);
        debounceCount = newCount;
      } else if (data === "\x15") {
        newCount = 0;
        debounceCount = 0;
      } else {
        newCount = count + data.length;
        debounceCount = newCount;
      }
      this.compositionCounts.set(id, newCount);

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
        }, this.getDebounceMs(debounceCount))
      );
    }
  }

  private getDebounceMs(count: number): number {
    return count < DIRECTING_PHASE2_THRESHOLD
      ? DIRECTING_DEBOUNCE_SHORT_MS
      : DIRECTING_DEBOUNCE_LONG_MS;
  }

  onEnterPressed(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (managed.kind !== "agent" || managed.canonicalAgentState !== "waiting") return;
    if (managed.agentState === "working") return;

    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }
    this.compositionCounts.delete(id);

    managed.agentState = "working";
    this.notifySubscribers(managed, "working");
    useTerminalStore.getState().updateAgentState(id, "working");
  }

  clearDirectingState(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || managed.agentState !== "directing") return;

    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }
    this.compositionCounts.delete(id);

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
    this.compositionCounts.delete(id);
  }

  dispose(): void {
    for (const timer of this.directingTimers.values()) {
      clearTimeout(timer);
    }
    this.directingTimers.clear();
    this.compositionCounts.clear();
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
