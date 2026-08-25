import { notify } from "./notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isScratchWorkspaceId } from "@shared/utils/workspaceIds";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

/**
 * Toggle to the workspace this window was in before the current one — project
 * or scratch alike (#11936).
 *
 * Self-inverse by construction: arriving somewhere makes the place you left the
 * new "last workspace", so pressing the shortcut twice returns you to where you
 * started no matter how many are open. That is the property worth protecting —
 * it is what lets the key be pressed without looking, and it only holds if
 * every workspace occupies a slot. A scratch that left no trace made the key
 * land somewhere else entirely, on the destination people reach for most.
 *
 * The list itself lives in main: renderer contexts are per-workspace and are
 * torn down on a cold switch, so one kept here would not survive the navigation
 * it exists for. Main resolves the destination but does not perform the switch —
 * that goes back through the stores, the route the palette already takes, which
 * owns the view swap, the per-window serialisation and the outgoing-state
 * persist.
 *
 * Deliberately unguarded against rapid re-presses. A module-level in-flight
 * flag looks safe on the assumption that the outgoing renderer is destroyed by
 * the swap, but `ProjectViewManager` keeps recently-used views alive in an LRU
 * cache — so the flag survives in the very view the user toggles back into, and
 * swallows the next press until it expires. `projectStore.switchProject`
 * already drops a switch to the project it is on and supersedes an in-flight
 * transition by request id, which is where that concern belongs.
 */
export async function switchToLastWorkspace(): Promise<void> {
  try {
    const target = await window.electron.projectHistory.peek();
    // A window that has only ever been in one workspace has nowhere to go. Not
    // a failure, and not worth interrupting for.
    if (!target) return;

    const projectState = useProjectStore.getState();
    const scratchState = useScratchStore.getState();

    // The view's own immutable workspace id, never `currentScratch`: scratch
    // switches reach every renderer through `broadcastToRenderer`, so
    // `currentScratch` says what the user is looking at *globally*. A second
    // window entering the scratch this one is about to toggle into would make
    // that pointer match here and swallow the press. `currentProject` is the
    // pre-seed fallback and stays view-targeted.
    const currentWorkspaceId = getViewWorkspaceId() ?? projectState.currentProject?.id;
    if (currentWorkspaceId === target.workspaceId) return;

    // Routed on the id's shape, not on whether the scratch store lists it: both
    // stores hydrate asynchronously, so a membership test answers "has the list
    // loaded yet" and sends a scratch down the project path during boot. Main
    // has already pruned anything that no longer exists.
    if (isScratchWorkspaceId(target.workspaceId)) {
      await scratchState.switchScratch(target.workspaceId);
      return;
    }

    // The project list decides how to arrive, never whether the target is a
    // project: a backgrounded project still holds live processes, and reopening
    // reconnects them instead of treating it as cold.
    const project = projectState.projects.find((candidate) => candidate.id === target.workspaceId);
    const switchFn =
      project?.status === "background" ? projectState.reopenProject : projectState.switchProject;
    await switchFn(target.workspaceId);
  } catch (error) {
    notify({
      type: "error",
      title: "Couldn't switch workspace",
      message: formatErrorMessage(error, "Couldn't switch workspace"),
      actions: [
        {
          label: "Try again",
          variant: "primary",
          onClick: () => {
            void switchToLastWorkspace();
          },
        },
      ],
    });
  }
}
