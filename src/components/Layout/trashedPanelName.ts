import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { cleanTaskTitle } from "@shared/utils/taskTitle";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

/** A trashed panel's name: a frozen user title, else its last task, else its launch identity. */
export function resolveTrashedPanelName(terminal: PanelInstance): string | null {
  if (isPtyPanel(terminal)) {
    // A user-locked title is fully frozen — it outranks the observed task.
    if ((terminal.titleMode ?? "default") === "user") return terminal.title;
    const observed = cleanTaskTitle(terminal.lastObservedTitle);
    if (observed && !isUselessTitle(observed)) return observed;
    if (terminal.launchAgentId) {
      if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
      const agentConfig = getEffectiveAgentConfig(terminal.launchAgentId);
      return agentConfig?.name ?? terminal.launchAgentId;
    }
  }
  if (terminal.title && !isUselessTitle(terminal.title)) return terminal.title;
  return null;
}
