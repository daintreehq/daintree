import type { PluginSendToAgentResult } from "@shared/types/plugin";
import type { ActionDispatchResult, ActionId } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import { logWarn } from "@/utils/logger";
import { draftAgentContext, reportDraftRefused, type AgentHandoffContent } from "./agentDraft";

/** The shape of the three actions this composes, as far as it reads them. */
export interface HandoffActionDispatcher {
  dispatch(actionId: ActionId, args: unknown): Promise<ActionDispatchResult>;
}

const userDispatcher: HandoffActionDispatcher = {
  // The user picked the row, so these run as the user's own actions — the same
  // confirm and danger rules as clicking New worktree or an agent button.
  dispatch: (actionId, args) => actionService.dispatch(actionId, args, { source: "user" }),
};

const MAX_BRANCH_SLUG_LENGTH = 48;

/**
 * A branch name to offer for a handoff titled `title`: lowercase words joined
 * by hyphens. Only a starting point — the picker lets the user edit it, and the
 * worktree action rejects an invalid ref rather than rewriting it.
 */
export function branchNameForHandoff(title: string | undefined): string {
  const slug = (title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    // Decomposition splits "é" into "e" and a combining mark; drop the marks.
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || "agent-handoff";
}

export type HandoffLaunchTarget =
  { kind: "existing-worktree"; worktreeId?: string } | { kind: "new-worktree"; branchName: string };

/** One field of an action's untyped result, read without asserting its shape. */
function field(result: unknown, key: string): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  const value: unknown = Reflect.get(result, key);
  return value;
}

function fail(reason: string, detail?: unknown): PluginSendToAgentResult {
  logWarn(`[agentHandoff] ${reason}`, detail === undefined ? undefined : { detail });
  reportDraftRefused("launch-failed");
  return { status: "refused", reason: "launch-failed" };
}

/**
 * Start a new agent for a handoff and draft the text into it — never as the
 * launch `prompt`, which the agent would submit as its first turn.
 *
 * For a new worktree this is the same composition an agent would script:
 * create it, give its setup the documented wait (running out of time is not a
 * failure — the tree exists, setup carries on), then launch into it. Resolves
 * rather than rejects on every path, because the picker has already closed and
 * the plugin's promise is waiting on this answer.
 */
export async function launchAgentForHandoff(
  agentId: string,
  target: HandoffLaunchTarget,
  content: AgentHandoffContent,
  dispatcher: HandoffActionDispatcher = userDispatcher
): Promise<PluginSendToAgentResult> {
  try {
    let worktreeId = target.kind === "existing-worktree" ? target.worktreeId : undefined;

    if (target.kind === "new-worktree") {
      const created = await dispatcher.dispatch("worktree.createWithRecipe", {
        source: { kind: "newBranch", branchName: target.branchName },
      });
      if (!created.ok) return fail("worktree creation failed", created.error);
      const createdId = field(created.result, "worktreeId");
      if (typeof createdId !== "string") return fail("worktree creation returned no id");
      worktreeId = createdId;
      await dispatcher.dispatch("worktree.waitUntilReady", { worktreeId });
    }

    const launched = await dispatcher.dispatch("agent.launch", {
      agentId,
      location: "grid",
      ...(worktreeId !== undefined ? { worktreeId } : {}),
    });
    if (!launched.ok) return fail("agent launch failed", launched.error);
    const terminalId = field(launched.result, "terminalId");
    if (field(launched.result, "launched") !== true || typeof terminalId !== "string") {
      return fail("agent launch produced no terminal");
    }
    // The pane's input bar mounts after this resolves; the draft store holds
    // the text until it does, so the availability gate is skipped for it.
    return draftAgentContext(terminalId, content, { skipChecks: true });
  } catch (error) {
    return fail("agent handoff launch threw", error);
  }
}
