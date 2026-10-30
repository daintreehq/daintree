import { CHANNELS } from "../../ipc/channels.js";
import { isWithheldFromView } from "../../ipc/utils.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import type { TerminalFirstPrompt } from "../../../shared/types/panel.js";
import type { ProjectState } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * Hand a run's first sent prompt (#15521) to whoever keeps its pane: this
 * machine's views of the owning project, whose store records and saves it, or
 * with none open, the project's saved state, which the next view hydrates
 * from. Never a remote view or the event bus, since the record stays on this
 * machine.
 */
export function deliverFirstPrompt(
  projectId: string,
  terminalId: string,
  firstPrompt: TerminalFirstPrompt
): void {
  const envelope = { name: "terminal:first-prompt", payload: { id: terminalId, firstPrompt } };
  const views = getWebContentsForProject(projectId).filter(
    (wc) => !isWithheldFromView(wc.id, CHANNELS.EVENTS_PUSH, [envelope])
  );
  if (views.length === 0) {
    void recordFirstPromptInProjectState(projectId, terminalId, firstPrompt);
    return;
  }
  for (const wc of views) {
    try {
      wc.send(CHANNELS.EVENTS_PUSH, envelope);
    } catch {
      // A view torn down mid-send hydrates from saved state instead.
    }
  }
}

/**
 * The saved state with `firstPrompt` on the pane, or null when it is no
 * longer an agent pane without one: a pane removed, trashed or already holding
 * a record keeps what it has.
 */
export function withFirstPrompt(
  state: ProjectState | null,
  terminalId: string,
  firstPrompt: TerminalFirstPrompt
): ProjectState | null {
  const pane = state?.terminals.find((t) => t.id === terminalId);
  if (!state || !pane || pane.firstPrompt || !pane.launchAgentId) return null;
  if (pane.location === "trash" || (pane.kind !== undefined && !panelKindHasPty(pane.kind))) {
    return null;
  }
  return {
    ...state,
    terminals: state.terminals.map((t) => (t.id === terminalId ? { ...t, firstPrompt } : t)),
  };
}

async function recordFirstPromptInProjectState(
  projectId: string,
  terminalId: string,
  firstPrompt: TerminalFirstPrompt
): Promise<void> {
  try {
    // Lazy: the store's constructor needs `app`, which this module's
    // importers don't otherwise load.
    const { projectStore } = await import("../ProjectStore.js");
    await projectStore.enqueueProjectStateUpdate(projectId, (existing) =>
      withFirstPrompt(existing, terminalId, firstPrompt)
    );
  } catch (err) {
    console.warn(
      `[FirstPrompt] Couldn't save terminal ${terminalId.slice(0, 8)}'s first prompt:`,
      formatErrorMessage(err, "unknown")
    );
  }
}
