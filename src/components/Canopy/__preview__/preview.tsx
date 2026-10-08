import {
  FROZEN_NOW,
  setPreviewCanopyBranches,
  setPreviewCanopyScreens,
  setPreviewCanopySnapshot,
} from "./bootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { CanopyView } from "../CanopyView";
import { isCanopyFixture, previewScreenFor, projectsFor, sceneFor } from "./fixtures";
import "@xterm/xterm/css/xterm.css";
import "@/index.css";

/**
 * Standalone visual-review harness for the canopy panel.
 *
 * Mounts the real `CanopyView` against the real theme tokens and `index.css`,
 * with the fleet, project and canopy stores seeded in the shapes main pushes,
 * and a stand-in `window.electron.canopy` that answers with the same snapshot.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=fleet|describing|off|read-error|calm|empty|long
 *   ?projectId=…              the view's own workspace (the spec passes Daintree's)
 *
 * The last action the panel sent main is mirrored onto `body[data-canopy-last]`.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const requested = params.get("fixture");
const fixture = isCanopyFixture(requested) ? requested : "fleet";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const scene = sceneFor(fixture, FROZEN_NOW);
setPreviewCanopySnapshot(scene.canopy);
setPreviewCanopyScreens(
  new Map((scene.canopy.cards ?? []).map((card) => [card.runId, previewScreenFor(card)]))
);
// A worktree folder named feature-x has feature/x checked out; a project's own
// checkout sits on its default branch.
setPreviewCanopyBranches(
  new Map(
    scene.fleet.runs.map((run) => {
      const folder = run.cwd.split("/").pop() ?? "";
      const inWorktree = run.cwd.includes("-worktrees/");
      return [run.runId, inWorktree ? folder.replace(/^feature-/, "feature/") : "develop"];
    })
  )
);
useProjectStore.setState({ projects: projectsFor(FROZEN_NOW) });
useFleetSnapshotStore.setState({ snapshot: scene.fleet });
useCanopyStore.setState({ isOpen: true, snapshot: scene.canopy });

// The real composer reads the view's worktree store, as it does in the app.
const worktreeStore = createWorktreeStore();
setCurrentViewStore(worktreeStore);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={worktreeStore}>
          <div data-preview-shell="" className="h-screen bg-surface-canvas" />
          <CanopyView />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    </StrictMode>
  );
}
