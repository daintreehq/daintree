import type { AgentState } from "@/types";
import type { ManagedTerminal } from "./types";
import { usePanelStore } from "@/store/panelStore";
import { logDebug, logError } from "@/utils/logger";

export interface AgentStateControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
}

const DIRECTING_DEBOUNCE_SHORT_MS = 1500;
const DIRECTING_DEBOUNCE_LONG_MS = 10000;
const DIRECTING_PHASE2_THRESHOLD = 5;

// Wall-clock cap. The debounce timer is the primary clearance path, but
// Chromium's IntensiveWakeUpThrottling can delay setTimeout up to ~60s in
// backgrounded WebContentsViews. On visibilitychange we sweep stale entries
// older than this so the directing indicator never persists after the user
// returns to the view.
const DIRECTING_MAX_WALL_MS = 15000;

type DirectingExitTrigger =
  | "timer"
  | "enter-key"
  | "escape-key"
  | "canonical-change"
  | "wall-clock-guardrail"
  | "rehydration-stale"
  | "destroy"
  | "external";

export class TerminalAgentStateController {
  private directingTimers = new Map<string, number>();
  private directingEnteredAt = new Map<string, number>();
  private compositionCounts = new Map<string, number>();
  private deps: AgentStateControllerDeps;
  private visibilityListenerAttached = false;

  constructor(deps: AgentStateControllerDeps) {
    this.deps = deps;
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityListenerAttached = true;
    }
  }

  setAgentState(id: string, state: AgentState): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (state === "directing") return;

    managed.canonicalAgentState = state;

    if (state !== "waiting") {
      this.clearDirectingInternal(id, "canonical-change");
    }

    const previousState = managed.agentState;
    if (previousState === state) return;

    if (previousState === "directing" && state === "waiting") return;

    managed.agentState = state;

    if (previousState === "working" && state === "waiting") {
      this.firePostCompleteHook(managed);
    }

    this.notifySubscribers(managed, state);
  }

  onUserInput(id: string, data: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.runtimeAgentId && managed.canonicalAgentState === "waiting") {
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

      // Refreshed per keystroke so the wall-clock guardrail measures "time
      // since last input", matching the issue spec. Active typers are
      // continuously refreshed and never swept; abandoned/throttled sessions
      // age past the cap.
      this.directingEnteredAt.set(id, Date.now());

      if (managed.agentState !== "directing") {
        managed.agentState = "directing";
        logDebug("[directing] enter", { terminalId: id, trigger: "user-input" });
        this.notifySubscribers(managed, "directing");
        usePanelStore.getState().updateAgentState(id, "directing");
      }

      const existingTimer = this.directingTimers.get(id);
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
      }
      this.directingTimers.set(
        id,
        window.setTimeout(() => {
          this.clearDirectingInternal(id, "timer");
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
    if (!managed.runtimeAgentId || managed.canonicalAgentState !== "waiting") return;
    if (managed.agentState === "working") return;

    const wasDirecting = managed.agentState === "directing";

    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }
    this.compositionCounts.delete(id);
    this.directingEnteredAt.delete(id);

    if (wasDirecting) {
      logDebug("[directing] exit", { terminalId: id, trigger: "enter-key" });
    }

    managed.agentState = "working";
    this.notifySubscribers(managed, "working");
    usePanelStore.getState().updateAgentState(id, "working");
  }

  clearDirectingState(id: string, trigger: string = "external"): void {
    this.clearDirectingInternal(id, trigger as DirectingExitTrigger);
  }

  /**
   * Force-revert any stale directing state for a rehydrated/reattached terminal.
   * Belt-and-braces: if `managed.agentState === "directing"` but no controller
   * timer is tracking it, the state cannot self-clear and must be cleared now.
   */
  checkStaleDirecting(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || managed.agentState !== "directing") return;
    if (this.directingTimers.has(id)) return;
    this.clearDirectingInternal(id, "rehydration-stale");
  }

  destroy(id: string): void {
    const managed = this.deps.getInstance(id);
    const wasDirecting = managed?.agentState === "directing";

    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }
    this.compositionCounts.delete(id);
    this.directingEnteredAt.delete(id);

    if (wasDirecting) {
      logDebug("[directing] exit", { terminalId: id, trigger: "destroy" });
    }
  }

  dispose(): void {
    for (const timer of this.directingTimers.values()) {
      clearTimeout(timer);
    }
    this.directingTimers.clear();
    this.compositionCounts.clear();
    this.directingEnteredAt.clear();

    if (this.visibilityListenerAttached) {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityListenerAttached = false;
    }
  }

  private clearDirectingInternal(id: string, trigger: DirectingExitTrigger): void {
    const managed = this.deps.getInstance(id);
    if (!managed || managed.agentState !== "directing") return;

    const timer = this.directingTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.directingTimers.delete(id);
    }
    this.compositionCounts.delete(id);
    this.directingEnteredAt.delete(id);

    const revertState = managed.canonicalAgentState ?? "waiting";
    managed.agentState = revertState;

    logDebug("[directing] exit", { terminalId: id, trigger, revertState });

    this.notifySubscribers(managed, revertState);
    usePanelStore.getState().updateAgentState(id, revertState);
  }

  private handleVisibilityChange = (): void => {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;

    // Sweep regardless of timer presence: a backgrounded debounce timer
    // can be delayed up to ~60s by Chromium IntensiveWakeUpThrottling, so
    // a "still pending" timer is not evidence of an active session. The
    // enteredAt timestamp (refreshed on each keystroke) is the source of
    // truth — entries older than the cap mean the user has not typed for
    // 15s+, so the directing indicator is definitionally stale.
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, enteredAt] of this.directingEnteredAt.entries()) {
      if (now - enteredAt >= DIRECTING_MAX_WALL_MS) {
        stale.push(id);
      }
    }
    for (const id of stale) {
      this.clearDirectingInternal(id, "wall-clock-guardrail");
    }
  };

  private firePostCompleteHook(managed: ManagedTerminal): void {
    const hook = managed.postCompleteHook;
    if (!hook) return;

    // One-shot: remove before calling to prevent re-entry
    managed.postCompleteHook = undefined;
    const marker = managed.postCompleteMarker;
    managed.postCompleteMarker = undefined;

    // Extract plain text from marker position to buffer end
    const buf = managed.terminal.buffer.active;
    let startLine = 0;
    if (marker && !marker.isDisposed && marker.line >= 0) {
      startLine = marker.line;
      marker.dispose();
    }

    const lines: string[] = [];
    for (let i = startLine; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const output = lines.join("\n");

    // Fire-and-forget — do not block state transition path
    try {
      const result = hook(output);
      if (result instanceof Promise) {
        result.catch((err) => logError("Post-complete hook error", err));
      }
    } catch (err) {
      logError("Post-complete hook error", err);
    }
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
