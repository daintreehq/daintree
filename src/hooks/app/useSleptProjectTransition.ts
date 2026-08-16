import { useEffect } from "react";
import { useProjectStore } from "@/store/projectStore";
import { logDebug } from "@/utils/logger";

/**
 * Drop this window to the no-project state when the project it is showing is
 * put to sleep from somewhere else.
 *
 * `project:sleep` accepts a project that is on screen, and the window that
 * asked for it transitions itself. A SECOND window showing the same project
 * gets no such call, and main deliberately does not tear its view down (that
 * would blank it — the window's renderer IS the project's `WebContentsView`).
 * Without this it would keep painting panels whose terminals are gone.
 *
 * Gated narrowly on the project this view is currently showing flipping to
 * `closed`: the only writers of that transition are sleep and close, and the
 * closing window already transitioned itself, so re-running it there is a
 * no-op rather than a second teardown.
 */
export function useSleptProjectTransition(): void {
  useEffect(() => {
    return window.electron.project.onUpdated((project) => {
      const state = useProjectStore.getState();
      if (state.currentProject?.id !== project.id) return;
      if (project.status !== "closed") return;

      logDebug("[useSleptProjectTransition] Current project was slept elsewhere", {
        projectId: project.id,
      });
      state.dropToNoProject();
    });
  }, []);
}
