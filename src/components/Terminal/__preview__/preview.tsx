import "./installShims";
import { StrictMode, use, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { WorktreeSnapshot } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { usePaletteStore } from "@/store/paletteStore";
import { ResumeSessionsPalette } from "../ResumeSessionsPalette";
import { PROJECT, WORKTREES } from "./resumeSessionFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the resume-sessions palette.
 *
 * The palette lists the closed-session journal, and in the app that journal
 * only fills as sessions are closed over days — the existing palette harness
 * captures it empty for exactly that reason. This mounts the real palette
 * against the real stores and `index.css`, with the journal answered from a
 * fixture, so the populated states can be looked at.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…     built-in theme id
 *   ?fixture=populated|many|…   which journal to serve (see resumeSessionFixtures)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

// Seed before mounting: the palette's data hook gates its fetch on the open
// state, and a store write during render is a cross-component update.
useProjectStore.setState({ currentProject: PROJECT });
usePaletteStore.getState().openPalette("resume-sessions");

/** The per-view worktree store is created by the provider, so it is seeded from inside the tree. */
function SeedWorktrees({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({
      worktrees: new Map<string, WorktreeSnapshot>(WORKTREES.map((wt) => [wt.id, wt])),
    });
    return true;
  });
  return ready ? children : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WorktreeStoreProvider>
        <SeedWorktrees>
          <div data-preview-shell />
          <ResumeSessionsPalette />
        </SeedWorktrees>
      </WorktreeStoreProvider>
    </TooltipProvider>
  </StrictMode>
);
