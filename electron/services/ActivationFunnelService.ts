import { events } from "./events.js";
import { store } from "../store.js";
import { trackEvent } from "./TelemetryService.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";

/**
 * Startup-restored terminals replay spawn and state events. Suppress activation
 * milestone firing during the grace window so existing users don't have "first
 * task" events attributed to an app relaunch after the activationFunnel guard
 * has been cleared (e.g. via migration or store reset).
 */
const BOOT_GRACE_PERIOD_MS = 8_000;

const ACTIVE_AGENT_STATES = new Set(["working", "running", "directing"]);

type StateChangePayload = {
  state: string;
  previousState?: string;
  timestamp: number;
};

type CompletedPayload = {
  agentId: string;
  exitCode: number;
  duration: number;
  terminalId?: string;
  worktreeId?: string;
  timestamp: number;
};

type ActivationFunnel = {
  firstAgentTaskStartedAt?: number;
  firstAgentTaskCompletedAt?: number;
  firstParallelAgentsAt?: number;
  timeToFirstAgentTaskMs?: number;
};

class ActivationFunnelService {
  private appLaunchMs = 0;
  private initializedAt = 0;
  private unsubscribers: Array<() => void> = [];
  private reconcileTimer: NodeJS.Timeout | null = null;

  initialize(opts: { appLaunchMs: number }): void {
    this.appLaunchMs = opts.appLaunchMs;
    this.initializedAt = Date.now();

    const unsubStateChanged = events.on("agent:state-changed", (payload) => {
      this.handleStateChanged(payload);
    });

    const unsubCompleted = events.on("agent:completed", (payload) => {
      this.handleCompleted(payload);
    });

    this.unsubscribers.push(unsubStateChanged, unsubCompleted);

    // Reconcile once after the boot grace window: if the user relaunches with
    // two agents already running (no transition event will fire for existing
    // state), we still want the parallel-agents milestone to land in this
    // session. Guarded by the persisted `firstParallelAgentsAt` timestamp so
    // it's idempotent across restarts. Clear any orphan timer from a prior
    // initialize call — double-init without dispose would otherwise leak.
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.maybeFireFirstParallelAgents();
    }, BOOT_GRACE_PERIOD_MS + 100);
  }

  private isWithinBootGrace(): boolean {
    return Date.now() - this.initializedAt < BOOT_GRACE_PERIOD_MS;
  }

  private getFunnel(): ActivationFunnel {
    const value = store.get("activationFunnel") as ActivationFunnel | undefined;
    return value ?? {};
  }

  private setFunnel(next: ActivationFunnel): void {
    store.set("activationFunnel", next);
  }

  private countActiveAgents(): number {
    const terminals = store.get("appState")?.terminals ?? [];
    return terminals.filter(
      (t: { agentState?: string }) => t.agentState && ACTIVE_AGENT_STATES.has(t.agentState)
    ).length;
  }

  private handleStateChanged(payload: StateChangePayload): void {
    const { state, previousState } = payload;

    const wasActive = previousState !== undefined && ACTIVE_AGENT_STATES.has(previousState);
    const isActive = ACTIVE_AGENT_STATES.has(state);

    // Transitioning into an active state from a non-active state — a task
    // just started (either the first one ever, or a later one).
    if (!wasActive && isActive) {
      this.maybeFireFirstTaskStarted();
      this.maybeFireFirstParallelAgents();
    }
  }

  private handleCompleted(payload: CompletedPayload): void {
    // `agent:completed` already excludes user-killed terminals upstream
    // (`TerminalProcess.ts` only emits when `!wasKilled`). Requiring
    // `exitCode === 0` further narrows the "first successful task" milestone
    // to clean exits — interrupted runs (e.g. ctrl-C, 130) are intentionally
    // excluded so activation telemetry reflects *completed work*, not
    // abandoned attempts.
    if (payload.exitCode !== 0) return;
    if (this.isWithinBootGrace()) return;

    const funnel = this.getFunnel();
    if (funnel.firstAgentTaskCompletedAt !== undefined) return;

    const now = Date.now();
    this.setFunnel({ ...funnel, firstAgentTaskCompletedAt: now });

    trackEvent("activation_first_agent_task_completed", {
      duration_ms: payload.duration,
      exit_code: payload.exitCode,
    });
  }

  private maybeFireFirstTaskStarted(): void {
    if (this.isWithinBootGrace()) return;

    const funnel = this.getFunnel();
    if (funnel.firstAgentTaskStartedAt !== undefined) return;

    const now = Date.now();
    const timeToFirstAgentTaskMs = Math.max(0, now - this.appLaunchMs);
    this.setFunnel({
      ...funnel,
      firstAgentTaskStartedAt: now,
      timeToFirstAgentTaskMs,
    });

    trackEvent("activation_first_agent_task_started", {
      time_to_first_agent_task_ms: timeToFirstAgentTaskMs,
    });
  }

  private maybeFireFirstParallelAgents(): void {
    if (this.isWithinBootGrace()) return;

    const funnel = this.getFunnel();
    if (funnel.firstParallelAgentsAt !== undefined) return;

    const activeCount = this.countActiveAgents();
    if (activeCount < 2) return;

    const now = Date.now();
    this.setFunnel({ ...funnel, firstParallelAgentsAt: now });

    trackEvent("activation_first_parallel_agents", {
      agent_count: activeCount,
    });

    this.markChecklistAndBroadcast();
  }

  private markChecklistAndBroadcast(): void {
    const onboarding = store.get("onboarding");
    if (!onboarding?.checklist) return;
    if (onboarding.checklist.items.ranSecondParallelAgent) return;

    const nextChecklist = {
      ...onboarding.checklist,
      items: {
        ...onboarding.checklist.items,
        ranSecondParallelAgent: true,
      },
    };
    store.set("onboarding", { ...onboarding, checklist: nextChecklist });
    broadcastToRenderer(CHANNELS.ONBOARDING_CHECKLIST_PUSH, nextChecklist);
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.appLaunchMs = 0;
    this.initializedAt = 0;
  }
}

export const activationFunnelService = new ActivationFunnelService();
