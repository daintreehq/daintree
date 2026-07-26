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
 */
/**
 * How long a fired switch is treated as still in flight.
 *
 * Only a failsafe. On the happy path this view is detached long before it
 * elapses, taking the flag with it; the timer exists so a switch that fails
 * before the swap can't leave the shortcut permanently dead.
 */
const SWITCH_SETTLE_MS = 4000;

let switchInFlight = false;

export async function switchToLastProject(): Promise<void> {
  // `projectStore.switchProject` is fire-and-forget — main swaps the
  // WebContentsView out from under this renderer, so it returns long before the
  // switch commits, and main only folds the switch into history once the swap
  // lands. A second press in that window would peek the unchanged history, get
  // the same destination back, and fire a duplicate switch at the project
  // already being loaded.
  if (switchInFlight) return;

  try {
    const target = await window.electron.projectHistory.peek();
    // A window that has only ever been in one project has nowhere to go. Not a
    // failure, and not worth interrupting for.
    if (!target) return;

    const state = useProjectStore.getState();
    if (state.currentProject?.id === target.projectId) return;

    const project = state.projects.find((candidate) => candidate.id === target.projectId);
    const switchFn = project?.status === "background" ? state.reopenProject : state.switchProject;

    switchInFlight = true;
    setTimeout(() => {
      switchInFlight = false;
    }, SWITCH_SETTLE_MS);

    await switchFn(target.projectId);
  } catch (error) {
    switchInFlight = false;
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
