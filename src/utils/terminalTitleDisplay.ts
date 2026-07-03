import type { PanelInstance, PtyPanelData, TerminalInstance } from "@shared/types/panel";
import { isPtyPanel } from "@shared/types/panel";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { cleanTaskTitle } from "@shared/utils/taskTitle";

/**
 * How much room the rendering surface has for a terminal's display title.
 *
 * - `"full"` — grid panel headers, tooltips, aria labels: `"Claude: fix auth
 *   tests"`.
 * - `"compact"` — narrow tab strips (~100px): the task alone; the agent icon
 *   already carries identity, and an identity prefix would push the task out
 *   of the truncation window entirely.
 * - `"base"` — dock rows and other identity-dense chrome: the identity title
 *   only, no task.
 */
export type TerminalTitleVariant = "full" | "compact" | "base";

type TitledPanel = Pick<
  PtyPanelData,
  "title" | "titleMode" | "lastObservedTitle" | "detectedAgentId" | "agentState"
>;

/**
 * The agent's current task, or `null` when nothing should compose: no live
 * detected agent (stale tasks must not survive agent exit into plain-shell
 * display), a user-locked title, or a task that fails the usefulness filter.
 */
export function getTerminalTaskTitle(panel: TitledPanel): string | null {
  if ((panel.titleMode ?? "default") === "user") return null;
  if (panel.detectedAgentId === undefined || panel.agentState === "exited") return null;
  const task = cleanTaskTitle(panel.lastObservedTitle);
  if (!task || isUselessTitle(task)) return null;
  // An agent echoing the identity title back ("Claude") adds nothing.
  if (task === panel.title) return null;
  return task;
}

/**
 * Single source of truth for a terminal's human-facing title. Every surface
 * (tab, header, dock, palette, tooltip) renders through this — components
 * must not concatenate title strings themselves.
 */
export function getTerminalDisplayTitle(
  panel: PanelInstance | TerminalInstance,
  variant: TerminalTitleVariant,
  opts?: { showTask?: boolean }
): string {
  const base = panel.title;
  if (variant === "base" || opts?.showTask === false) return base;
  if (!isPtyPanel(panel)) return base;
  const task = getTerminalTaskTitle(panel);
  if (!task) return base;
  return variant === "compact" ? task : `${base}: ${task}`;
}
