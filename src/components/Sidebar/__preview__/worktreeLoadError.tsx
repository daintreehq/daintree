import "./bootstrap";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { SidebarContent } from "../SidebarContent";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { Project } from "@shared/types";
import "@/index.css";

/**
 * Standalone visual-review harness for the worktree sidebar's load-failure
 * states: `WorktreeLoadErrorBanner` and the workspace-service banner, in every
 * branch of `SidebarContent` that can mount them.
 *
 * These states only happen when a project switch's worktree load throws or the
 * workspace host never connects — rare in a live session and never on demand.
 * So this renders the REAL `SidebarContent` against seeded stores, the real
 * theme tokens and the real `index.css`, inside the sidebar's own chrome, so
 * the banner is judged in the column it actually sits in.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib   built-in theme id
 *   ?fixture=<name>               one of FIXTURE_NAMES below
 *   ?width=350                    sidebar width in CSS px
 *
 * Every fixture seeds stores BEFORE `createRoot().render()`, because the
 * sidebar picks its branch on the first render.
 */

const PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: Date.now(),
};

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "main",
    branch: "develop",
    isCurrent: false,
    isMainWorktree: true,
  },
  {
    id: "wt-banner",
    worktreeId: "wt-banner",
    path: "/Users/greg/Projects/daintree-worktrees/design-worktree-load-error-banner",
    name: "design-worktree-load-error-banner",
    branch: "design/worktree-load-error-banner",
    isCurrent: true,
  },
  {
    id: "wt-handback",
    worktreeId: "wt-handback",
    path: "/Users/greg/Projects/daintree-worktrees/issue-12488-handback",
    name: "issue-12488-handback",
    branch: "feature/issue-12488-handback",
    isCurrent: false,
  },
];

const SHORT_ERROR = "fatal: not a git repository (or any of the parent directories): .git";

/** What a real git failure looks like once it has passed through the bridge. */
const LONG_ERROR =
  "Error invoking remote method 'worktree:list': Error: git worktree list --porcelain failed " +
  "with exit code 128: fatal: '/Users/greg/Projects/daintree-worktrees/design-worktree-load-error-banner/.git' " +
  "does not appear to be a git repository\nfatal: Could not read from remote repository.\n\n" +
  "Please make sure you have the correct access rights and the repository exists.";

const SERVICE_ERROR = "Workspace host exited unexpectedly (code 1)";

interface Fixture {
  what: string;
  worktrees: WorktreeSnapshot[];
  isLoading: boolean;
  isInitialized: boolean;
  loadError: string | null;
  serviceError?: string;
}

const FIXTURES: Record<string, Fixture> = {
  /** The #8400 case: a switch committed, its load threw, the skeleton never resolves. */
  loading: {
    what: "switch committed, worktree load threw, list still loading",
    worktrees: [],
    isLoading: true,
    isInitialized: false,
    loadError: SHORT_ERROR,
  },
  /** The load settled empty after throwing. */
  empty: {
    what: "load threw and the list settled empty",
    worktrees: [],
    isLoading: false,
    isInitialized: true,
    loadError: SHORT_ERROR,
  },
  /** A retry that failed again over a list that did load earlier. */
  populated: {
    what: "load error over an already-populated list",
    worktrees: WORKTREES,
    isLoading: false,
    isInitialized: true,
    loadError: SHORT_ERROR,
  },
  /** A real multi-line git failure, the width and wrapping case. */
  "long-error": {
    what: "multi-line git stderr through the IPC bridge",
    worktrees: [],
    isLoading: true,
    isInitialized: false,
    loadError: LONG_ERROR,
  },
  /** An open project that never got a snapshot: the banner with its fixed copy (#12576). */
  disconnected: {
    what: "open project, workspace service never connected",
    worktrees: [],
    isLoading: false,
    isInitialized: false,
    loadError: null,
  },
  /** Both banners at once — the only fixture where the two families meet. */
  "with-service-error": {
    what: "load error and a workspace-service error together",
    worktrees: [],
    isLoading: false,
    isInitialized: true,
    loadError: SHORT_ERROR,
    serviceError: SERVICE_ERROR,
  },
  /** Disconnected with a fatal service error: the service banner stands alone. */
  "disconnected-service-error": {
    what: "never connected, with a workspace-service error",
    worktrees: [],
    isLoading: false,
    isInitialized: false,
    loadError: null,
    serviceError: SERVICE_ERROR,
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "350");
const fixtureName = params.get("fixture") ?? "loading";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const store = createWorktreeStore();
store.setState({
  worktrees: new Map(fixture.worktrees.map((w) => [w.id, w])),
  isLoading: fixture.isLoading,
  isInitialized: fixture.isInitialized,
  error: fixture.serviceError ?? null,
});
setCurrentViewStore(store);
useProjectStore.setState({ currentProject: PROJECT, worktreeLoadError: fixture.loadError });
useWorktreeSelectionStore.setState({
  activeWorktreeId: fixture.worktrees.length > 0 ? "wt-banner" : null,
});
// The shimmed bridge answers the store's pull with `undefined`, which every
// worktree row then filters. No plugins is the honest fixture.
usePluginContextMenuItemsStore.setState({ entries: [], init: () => undefined });

function Preview() {
  return (
    <div
      data-preview-shell
      data-fixture={fixtureName}
      className="sidebar-root relative flex h-screen flex-col overflow-hidden surface-chrome border-r border-divider"
      style={{ width: `${width}px` }}
    >
      <div className="flex-1 min-h-0 overflow-hidden">
        <SidebarContent onOpenOverview={() => undefined} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <DndContext>
        <WorktreeStoreContext.Provider value={store}>
          <Preview />
        </WorktreeStoreContext.Provider>
      </DndContext>
    </TooltipProvider>
  </StrictMode>
);
