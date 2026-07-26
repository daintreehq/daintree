import { notify } from "./notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useProjectStore } from "@/store/projectStore";

/**
 * Toggle to the project this window was in before the current one.
 *
 * Self-inverse by construction: arriving somewhere makes the place you left the
 * new "last project", so pressing the shortcut twice returns you to where you
 * started no matter how many projects are open. That is the property worth
 * protecting — it is what lets the key be pressed without looking.
 *
 * The list itself lives in main: renderer contexts are per-project and are torn
 * down on a cold switch, so one kept here would not survive the navigation it
 * exists for. Main resolves the destination but does not perform the switch —
 * that goes back through the project store, the route the palette already
 * takes, which owns the view swap, the per-window serialisation and the
 * outgoing-state persist.
 *
 * Deliberately unguarded against rapid re-presses. A module-level in-flight
 * flag looks safe on the assumption that the outgoing renderer is destroyed by
 * the swap, but `ProjectViewManager` keeps recently-used views alive in an LRU
 * cache — so the flag survives in the very view the user toggles back into, and
 * swallows the next press until it expires. `projectStore.switchProject`
 * already drops a switch to the project it is on and supersedes an in-flight
 * transition by request id, which is where that concern belongs.
 */
export async function switchToLastProject(): Promise<void> {
  try {
    const target = await window.electron.projectHistory.peek();
    // A window that has only ever been in one project has nowhere to go. Not a
    // failure, and not worth interrupting for.
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
            void switchToLastProject();
          },
        },
      ],
    });
  }
}
