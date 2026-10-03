import { FROZEN_NOW, setPreviewTriageSnapshot } from "./bootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTriageStore } from "@/store/triageStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { TriageView } from "../TriageView";
import { isTriageFixture, projectsFor, sceneFor } from "./fixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the triage panel.
 *
 * Mounts the real `TriageView` against the real theme tokens and `index.css`,
 * with the fleet, project and triage stores seeded in the shapes main pushes,
 * and a stand-in `window.electron.triage` that answers with the same snapshot.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=fleet|describing|unconfigured|read-error|calm|empty|long
 *   ?projectId=…              the view's own workspace (the spec passes Daintree's)
 *
 * The last action the panel sent main is mirrored onto `body[data-triage-last]`.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const requested = params.get("fixture");
const fixture = isTriageFixture(requested) ? requested : "fleet";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const scene = sceneFor(fixture, FROZEN_NOW);
setPreviewTriageSnapshot(scene.triage);
useProjectStore.setState({ projects: projectsFor(FROZEN_NOW) });
useFleetSnapshotStore.setState({ snapshot: scene.fleet });
useTriageStore.setState({ isOpen: true, snapshot: scene.triage });

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
          <TriageView />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    </StrictMode>
  );
}
