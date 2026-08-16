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
 * Listens on the dedicated `project:slept` event rather than inferring the
 * teardown from a `project:updated` that reaches `closed`: relocation, project
 * adoption, the idle sweep and a plain metadata write all reach that status
 * too, and blanking a visible window on any of those would be wrong.
 */
export function useSleptProjectTransition(): void {
  useEffect(() => {
    return window.electron.project.onSlept((projectId) => {
      // Read at delivery rather than closing over it: the effect subscribes
      // once and this window's project changes underneath it.
      const state = useProjectStore.getState();
      if (state.currentProject?.id !== projectId) return;

      logDebug("[useSleptProjectTransition] Current project was slept elsewhere", { projectId });
      state.dropToNoProject();
    });
  }, []);
}
