import type { PluginSendToAgentResult } from "@shared/types/plugin";
import type { ActionDispatchResult, ActionId } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import { logWarn } from "@/utils/logger";
import {
  draftAgentContext,
  getDraftRefusal,
  reportDraftNotAdded,
  type AgentHandoffContent,
} from "./agentDraft";

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

/**
 * Refuse as `launch-failed`, telling the user `why` and — when the worktree
 * was already created — naming it, so a half-finished handoff is never
 * reported as nothing having happened.
 */
function fail(why: string, detail?: unknown, worktreeId?: string): PluginSendToAgentResult {
  logWarn(`[agentHandoff] ${why}`, detail === undefined ? undefined : { detail });
  reportDraftNotAdded(why);
  return {
    status: "refused",
    reason: "launch-failed",
    ...(worktreeId !== undefined ? { worktreeId } : {}),
  };
}

/**
 * How many times to ask `worktree.waitUntilReady`, each capped by the action
 * at 25 s. Running out of one wait is not a failure — setup is still going —
 * so a few more are tried, about two minutes in all, before giving up.
 */
const SETUP_WAIT_ROUNDS = 5;

/** A launched pane reaches the panel store within a frame or two; allow a little more. */
const PANE_APPEAR_ATTEMPTS = 20;
const PANE_APPEAR_INTERVAL_MS = 100;

export interface HandoffLaunchDeps {
  dispatcher: HandoffActionDispatcher;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: HandoffLaunchDeps = {
  dispatcher: userDispatcher,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Why the new worktree cannot take an agent yet, or `null` once it can. */
async function waitForSetup(
  deps: HandoffLaunchDeps,
  worktreeId: string,
  branch: string
): Promise<string | null> {
  for (let round = 0; round < SETUP_WAIT_ROUNDS; round++) {
    const status = await deps.dispatcher.dispatch("worktree.waitUntilReady", { worktreeId });
    if (!status.ok) return `worktree ${branch} was created, but its setup couldn't be checked`;
    if (field(status.result, "timedOut") === true) continue;
    switch (field(status.result, "setupState")) {
      // Unknown means this host did not track it (a restart, an adopted
      // worktree): there is nothing to wait for, and the tree exists.
      case "ready":
      case "unknown":
        return null;
      case "needs-approval":
        return `worktree ${branch} was created, but its setup needs your approval`;
      case "failed":
      case "timed-out":
        return `worktree ${branch} was created, but its setup failed`;
      default:
        continue;
    }
  }
  return `worktree ${branch} was created, but its setup is still running`;
}

/**
 * Start a new agent for a handoff and draft the text into it — never as the
 * launch `prompt`, which the agent would submit as its first turn.
 *
 * For a new worktree this is the same composition an agent would script:
 * create it, wait for its setup, then launch into it. A setup that fails, needs
 * the user's approval or is still running after the waits stops the handoff
 * there, reporting the worktree it made. The draft itself goes through the same
 * gate as every other handoff, once the new pane is in the store, so a pane
 * that locked or exited while it started is refused rather than drafted into.
 *
 * Resolves rather than rejects on every path, because the picker has already
 * closed and the plugin's promise is waiting on this answer.
 */
export async function launchAgentForHandoff(
  agentId: string,
  target: HandoffLaunchTarget,
  content: AgentHandoffContent,
  overrides: Partial<HandoffLaunchDeps> = {}
): Promise<PluginSendToAgentResult> {
  const deps = { ...defaultDeps, ...overrides };
  let createdWorktreeId: string | undefined;
  try {
    let worktreeId = target.kind === "existing-worktree" ? target.worktreeId : undefined;

    if (target.kind === "new-worktree") {
      const created = await deps.dispatcher.dispatch("worktree.createWithRecipe", {
        source: { kind: "newBranch", branchName: target.branchName },
      });
      if (!created.ok) return fail("couldn't create the worktree", created.error);
      const createdId = field(created.result, "worktreeId");
      if (typeof createdId !== "string") return fail("couldn't create the worktree");
      createdWorktreeId = createdId;
      worktreeId = createdId;
      const effective = field(created.result, "effectiveBranch");
      const branch = typeof effective === "string" ? effective : target.branchName;
      const notReady = await waitForSetup(deps, createdId, branch);
      if (notReady !== null) return fail(notReady, undefined, createdId);
    }

    const launched = await deps.dispatcher.dispatch("agent.launch", {
      agentId,
      location: "grid",
      ...(worktreeId !== undefined ? { worktreeId } : {}),
    });
    if (!launched.ok) return fail("the new agent didn't start", launched.error, createdWorktreeId);
    const terminalId = field(launched.result, "terminalId");
    if (field(launched.result, "launched") !== true || typeof terminalId !== "string") {
      return fail("the new agent didn't start", undefined, createdWorktreeId);
    }

    for (let attempt = 0; attempt < PANE_APPEAR_ATTEMPTS; attempt++) {
      if (getDraftRefusal(terminalId) !== "unknown-terminal") break;
      await deps.sleep(PANE_APPEAR_INTERVAL_MS);
    }
    const result = draftAgentContext(terminalId, content);
    return result.status === "refused" && createdWorktreeId !== undefined
      ? { ...result, worktreeId: createdWorktreeId }
      : result;
  } catch (error) {
    return fail("the new agent didn't start", error, createdWorktreeId);
  }
}
