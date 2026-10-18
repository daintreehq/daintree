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
 * make and delete worktrees, and discover projects and runners. Everything
 * else is a question for a renderer, and is refused as "no frontend attached"
 * rather than guessed at.
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
  "worktree.create": write(),
  "worktree.list": read(),
  "worktree.waitUntilReady": read(),
  "worktree.delete": write("confirm"),
  "project.getAll": read(),
  "project.detectRunners": read(),
};

/** The declared danger of an action the host can run itself, or undefined. */
export function viewlessActionDanger(actionId: string): ActionDanger | undefined {
  return Object.hasOwn(VIEWLESS_ACTIONS, actionId) ? VIEWLESS_ACTIONS[actionId]?.danger : undefined;
}
