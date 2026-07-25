import { notify } from "./notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectHistoryDirection } from "@shared/types/ipc/project";

export type { ProjectHistoryDirection };

/**
 * Step back or forward through the projects this window has visited.
 *
 * The previous behaviour walked the recency list, which the act of arriving
 * mutated — so "back" always pointed at where you had just come from, two
 * projects ping-ponged forever, and a third was unreachable. The stack itself
 * lives in main: renderer contexts are per-project and are torn down on a cold
 * switch, so a stack kept here would not survive the navigation it exists for.
 *
 * Main resolves the destination but does not perform the switch. The switch
 * goes back through the project store, which is the route the palette already
 * takes — it owns the view swap, the per-window serialisation, and the
 * outgoing-state persist.
 */
export async function switchProjectByHistory(direction: ProjectHistoryDirection): Promise<void> {
  try {
    const target = await window.electron.projectHistory.peek(direction);
    // Reaching either end is not a failure and not worth interrupting for — the
    // same nothing a browser's greyed-out Back button does.
    if (!target) return;

    const state = useProjectStore.getState();
    if (state.currentProject?.id === target.projectId) return;

    const project = state.projects.find((candidate) => candidate.id === target.projectId);
    const switchFn = project?.status === "background" ? state.reopenProject : state.switchProject;
    await switchFn(target.projectId);
  } catch (error) {
    notify({
      type: "error",
      title: "Couldn't switch project",
      message: formatErrorMessage(error, "Couldn't switch project"),
      actions: [
        {
          label: "Try again",
          variant: "primary",
          onClick: () => {
            void switchProjectByHistory(direction);
          },
        },
      ],
    });
  }
}
