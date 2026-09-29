import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { usePanelStore } from "@/store/panelStore";
import { useNotificationStore } from "@/store/notificationStore";
import type { WorktreeSetupState } from "@shared/types";

/**
 * How long a new worktree's first agent waits on setup before giving up and
 * handing the launch back to the user. Setup keeps running either way.
 */
export const FIRST_AGENT_SETUP_BUDGET_MS = 5 * 60_000;
/** How long a launched panel is watched for a failed spawn. */
const SPAWN_WATCH_MS = 60_000;
/** `worktree.waitUntilReady` refuses longer waits, so the budget is spent in slices. */
const WAIT_SLICE_MS = 25_000;

export interface FirstAgentLaunch {
  agentId: string;
  agentName: string;
  /** Held in memory only — never logged, never put in a notification. */
  prompt: string;
  worktreeId: string;
  cwd?: string;
}

export type SetupWaitOutcome = WorktreeSetupState | "still-running" | "error";

export type AgentNotStartedReason =
  | Exclude<SetupWaitOutcome, "ready" | "pending" | "running">
  | "recipe-has-agent"
  | "layout-has-agent"
  | "launch-failed";

export async function waitForWorktreeSetup(
  worktreeId: string,
  budgetMs: number = FIRST_AGENT_SETUP_BUDGET_MS
): Promise<SetupWaitOutcome> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const timeoutMs = Math.max(0, Math.min(WAIT_SLICE_MS, deadline - Date.now()));
    const result = await actionService.dispatch<{
      setupState: WorktreeSetupState;
      timedOut: boolean;
    }>("worktree.waitUntilReady", { worktreeId, timeoutMs }, { source: "user" });
    if (!result.ok) return "error";
    const { setupState, timedOut } = result.result;
    if (!timedOut) return setupState;
    if (Date.now() >= deadline) return "still-running";
  }
}

/** One `agent.launch`. A blank prompt starts the agent without a first turn. */
export async function launchFirstAgent(launch: FirstAgentLaunch): Promise<string | null> {
  try {
    const result = await actionService.dispatch<{ launched: boolean; terminalId: string | null }>(
      "agent.launch",
      {
        agentId: launch.agentId,
        worktreeId: launch.worktreeId,
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        ...(launch.prompt.trim() ? { prompt: launch.prompt } : {}),
      },
      { source: "user" }
    );
    if (!result.ok || !result.result.launched) return null;
    return result.result.terminalId ?? "";
  } catch {
    return null;
  }
}

/**
 * A launched panel still spawns its process afterwards, and the pane's own
 * restart rebuilds the command without the first prompt — so a spawn that
 * fails is handed back here too. Settles on the first non-spawning status; a
 * closed panel or a spawn slower than the watch counts as nothing to report.
 */
export function waitForSpawnOutcome(
  terminalId: string,
  timeoutMs: number = SPAWN_WATCH_MS
): Promise<"ready" | "failed" | "unknown"> {
  return new Promise((resolve) => {
    let settled = false;
    const watch: { unsubscribe?: () => void; timer?: ReturnType<typeof setTimeout> } = {};
    const settle = (outcome: "ready" | "failed" | "unknown") => {
      if (settled) return;
      settled = true;
      watch.unsubscribe?.();
      if (watch.timer !== undefined) clearTimeout(watch.timer);
      resolve(outcome);
    };
    const check = (state: ReturnType<typeof usePanelStore.getState>) => {
      const panel = state.panelsById[terminalId];
      if (!panel) return settle("unknown");
      const status = "spawnStatus" in panel ? panel.spawnStatus : undefined;
      if (status === "spawning") return;
      settle(status === "failed" ? "failed" : "ready");
    };
    check(usePanelStore.getState());
    if (settled) return;
    watch.unsubscribe = usePanelStore.subscribe(check);
    watch.timer = setTimeout(() => settle("unknown"), timeoutMs);
  });
}

async function launchOrNotify(launch: FirstAgentLaunch): Promise<void> {
  const terminalId = await launchFirstAgent(launch);
  if (terminalId === null) {
    notifyAgentNotStarted(launch, "launch-failed");
    return;
  }
  if (terminalId && (await waitForSpawnOutcome(terminalId)) === "failed") {
    notifyAgentNotStarted(launch, "launch-failed");
  }
}

function describeReason(reason: AgentNotStartedReason, agentName: string): string {
  switch (reason) {
    case "failed":
      return "Worktree setup failed.";
    case "timed-out":
      return "Worktree setup timed out.";
    case "needs-approval":
      return "Worktree setup is waiting for you to approve its commands.";
    case "still-running":
      return "Worktree setup is still running.";
    case "recipe-has-agent":
      return "The recipe already starts an agent.";
    case "layout-has-agent":
      return "The cloned layout already starts an agent.";
    case "launch-failed":
      return `${agentName} didn't start.`;
    default:
      return "Couldn't confirm worktree setup finished.";
  }
}

/** Setup that may still finish on its own: starting again waits for it rather than racing it. */
const REWAIT_REASONS: ReadonlySet<AgentNotStartedReason> = new Set([
  "still-running",
  "needs-approval",
]);

/**
 * The launch is handed back rather than dropped: the action replays the same
 * agent and prompt, and fires at most once so a double click can't start two.
 * Grid-bar placement because the dialog that asked for it is long closed, and
 * an inbox-only entry would lose the action that carries the prompt.
 */
export function notifyAgentNotStarted(
  launch: FirstAgentLaunch,
  reason: AgentNotStartedReason
): void {
  let fired = false;
  const bar = { id: "" };
  bar.id = notify({
    type: "warning",
    title: "Agent not started",
    message: `${describeReason(reason, launch.agentName)} Your prompt is kept for when you start it.`,
    correlationId: launch.worktreeId,
    context: { eventKind: "agent" },
    placement: "grid-bar",
    // Quiet hours would otherwise leave only an inbox row, which can't carry
    // the prompt back.
    urgent: true,
    duration: 0,
    action: {
      label: `Start ${launch.agentName}`,
      onClick: () => {
        if (fired) return;
        fired = true;
        // The grid bar persists after a click; clear it so a repeat failure's
        // fresh bar isn't hidden behind a spent one.
        if (bar.id) useNotificationStore.getState().dismissNotification(bar.id);
        void (REWAIT_REASONS.has(reason)
          ? startFirstAgentWhenReady(launch)
          : launchOrNotify(launch));
      },
    },
  });
}

/**
 * Starts the agent once setup reports ready. Anything short of ready — a
 * failure, a pending approval, or setup outlasting the budget — hands the
 * launch back to the user instead of starting into an unprepared tree.
 */
export async function startFirstAgentWhenReady(launch: FirstAgentLaunch): Promise<void> {
  let outcome: SetupWaitOutcome;
  try {
    outcome = await waitForWorktreeSetup(launch.worktreeId);
  } catch {
    outcome = "error";
  }
  if (outcome !== "ready") {
    notifyAgentNotStarted(
      launch,
      outcome === "pending" || outcome === "running" ? "still-running" : outcome
    );
    return;
  }
  await launchOrNotify(launch);
}
