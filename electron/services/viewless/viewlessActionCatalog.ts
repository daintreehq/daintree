import type { ActionDanger } from "../../../shared/types/actions.js";

export interface ViewlessActionEntry {
  danger: ActionDanger;
  /** Starts, types into, stops or deletes something, rather than only reading. */
  writes: boolean;
}

const read = (danger: ActionDanger = "safe"): ViewlessActionEntry => ({ danger, writes: false });
const write = (danger: ActionDanger = "safe"): ViewlessActionEntry => ({ danger, writes: true });

/**
 * The actions the host can run itself when no frontend is attached to their
 * project, each with the `danger` its renderer definition declares.
 *
 * The set is what an orchestrator drives through a whole loop with no window
 * open (#13495): open a terminal or an agent, read and steer it, close it,
 * make and delete worktrees, discover projects and runners, read the forge
 * the runbooks consult (#13501) and the threads and checks triage needs (#15399), find the host's tools (#13493), list an
 * agent's slash commands before typing one and the host's workspaces with
 * whether a frontend is attached to each (#14122), and look up what a launch
 * or a create takes and wait on a pull request (#14139), and the two reads
 * behind "what happened overnight": closed agent sessions from the journal
 * main holds and a worktree's commit pulse (#14549).
 * Everything else is a question for a renderer, and is refused as "no
 * frontend attached" rather than guessed at.
 *
 * The danger is restated here, not read from a manifest, because no manifest
 * is reachable with no view: the host's generated base surface covers only the
 * external tier. `viewlessActionParity.test.ts` holds each entry to the real
 * registry, so a definition that gains a confirmation fails there rather than
 * running here unattended.
 *
 * The owned twins and the batches need no entries: main checks ownership or
 * expands the batch, then dispatches the plain action this lists.
 */
export const VIEWLESS_ACTIONS: Readonly<Record<string, ViewlessActionEntry>> = {
  "terminal.new": write(),
  "terminal.sendCommand": write(),
  "terminal.list": read(),
  "terminal.getOutput": read(),
  "terminal.getStatus": read(),
  "terminal.close": write(),
  "terminal.interrupt": write(),
  "terminal.sendKeys": write(),
  "agent.launch": write(),
  "agent.listAvailable": read(),
  "slashCommands.list": read(),
  "agent.listPresets": read(),
  "agent.listModels": read(),
  "worktree.create": write(),
  "worktree.createWithRecipe": write(),
  "worktree.list": read(),
  "worktree.waitUntilReady": read(),
  "worktree.waitForPullRequest": read(),
  "worktree.delete": write("confirm"),
  "project.getAll": read(),
  "project.detectRunners": read(),
  "workspace.list": read(),
  // Listing reconciles the project's recipe files, as it does in a view.
  "recipe.list": write(),
  "forge.getPR": read(),
  "forge.getPRs": read(),
  "forge.listPRs": read(),
  "forge.getIssue": read(),
  "forge.listIssueComments": read(),
  "forge.listIssues": read(),
  "forge.getCIStatus": read(),
  "forge.getChecks": read(),
  "agentSessionHistory.list": read(),
  "git.getProjectPulse": read(),
  "actions.list": read(),
  "actions.search": read(),
  "actions.getSchema": read(),
  "actions.getContext": read(),
};

/** The declared danger of an action the host can run itself, or undefined. */
export function viewlessActionDanger(actionId: string): ActionDanger | undefined {
  return Object.hasOwn(VIEWLESS_ACTIONS, actionId) ? VIEWLESS_ACTIONS[actionId]?.danger : undefined;
}
