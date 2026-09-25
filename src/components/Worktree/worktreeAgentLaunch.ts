import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import type { WorktreeSetupState } from "@shared/types";

/**
 * How long a new worktree's first agent waits on setup before giving up and
 * handing the launch back to the user. Setup keeps running either way.
 */
export const FIRST_AGENT_SETUP_BUDGET_MS = 5 * 60_000;
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
export async function launchFirstAgent(launch: FirstAgentLaunch): Promise<boolean> {
  try {
    const result = await actionService.dispatch<{ launched: boolean }>(
      "agent.launch",
      {
        agentId: launch.agentId,
        worktreeId: launch.worktreeId,
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        ...(launch.prompt.trim() ? { prompt: launch.prompt } : {}),
      },
      { source: "user" }
    );
    return result.ok && result.result.launched;
  } catch {
    return false;
  }
}

async function launchOrNotify(launch: FirstAgentLaunch): Promise<void> {
  if (!(await launchFirstAgent(launch))) notifyAgentNotStarted(launch, "launch-failed");
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

/**
 * The launch is handed back rather than dropped: the action replays the same
 * agent and prompt, and fires at most once so a double click can't start two.
 */
export function notifyAgentNotStarted(
  launch: FirstAgentLaunch,
  reason: AgentNotStartedReason
): void {
  let fired = false;
  notify({
    type: "warning",
    title: "Agent not started",
    message: `${describeReason(reason, launch.agentName)} Your prompt is kept for when you start it.`,
    correlationId: launch.worktreeId,
    context: { eventKind: "agent" },
    duration: 0,
    action: {
      label: `Start ${launch.agentName}`,
      onClick: () => {
        if (fired) return;
        fired = true;
        void launchOrNotify(launch);
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
