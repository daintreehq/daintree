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
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { SidebarContent } from "../SidebarContent";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { Project } from "@shared/types";
import "@/index.css";

/**
 * Standalone visual-review harness for the worktree sidebar header's revealed
 * actions while a refresh is in flight, and for the disabled drag grip's
 * tooltip under each state that can disable reorder.
 *
 * Renders the REAL `SidebarContent` against seeded stores. A refresh is put in
 * flight by the spec dispatching the action's own `daintree:refresh-sidebar`
 * event — the path a palette or shortcut refresh takes.
 *
 * Query parameters:
 *   ?theme=<id>       built-in theme id
 *   ?fixture=<name>   one of FIXTURE_NAMES below
 *   ?width=350        sidebar width in CSS px
 */

const PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: Date.now(),
};

const root = "/Users/greg/Projects/daintree-worktrees";
const LIVE: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "main",
    branch: "develop",
    isCurrent: false,
    isMainWorktree: true,
  },
  ...[
    ["issue-12931-pane-toolbars", "feature/issue-12931-pane-toolbars"],
    ["issue-12940-button-states", "fix/issue-12940-button-states"],
    ["design-sidebar-refresh", "design/sidebar-refresh"],
  ].map(([name, branch], i): WorktreeSnapshot => ({
    id: `wt-${i}`,
    worktreeId: `wt-${i}`,
    path: `${root}/${name}`,
    name: name!,
    branch: branch!,
    isCurrent: i === 0,
  })),
];

const FIXTURES: Record<string, { query?: string; groupByType?: boolean }> = {
  /** Nothing disables reorder. */
  rest: {},
  /** A query: reorder off while searching. */
  search: { query: "issue" },
  /** Grouped by type: reorder off while grouped. */
  grouped: { groupByType: true },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "350");
const fixtureName = params.get("fixture") ?? "rest";
function resolveFixture(name: string): { query?: string; groupByType?: boolean } {
  const found = FIXTURES[name];
  if (!found) throw new Error(`unknown fixture "${name}" — one of ${FIXTURE_NAMES.join(", ")}`);
  return found;
}
const fixture = resolveFixture(fixtureName);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function seedStores() {
  const store = createWorktreeStore();
  store.setState({
    worktrees: new Map(LIVE.map((w) => [w.id, w])),
    isLoading: false,
    isInitialized: true,
    error: null,
  });
  setCurrentViewStore(store);
  useProjectStore.setState({ currentProject: PROJECT, worktreeLoadError: null });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-0" });
  useWorktreeFilterStore.setState({
    query: fixture.query ?? "",
    liveQuery: fixture.query ?? "",
    groupByType: fixture.groupByType ?? false,
  });
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => undefined });
  return store;
}

const store = seedStores();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <DndContext>
        <WorktreeStoreContext.Provider value={store}>
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
        </WorktreeStoreContext.Provider>
      </DndContext>
    </TooltipProvider>
  </StrictMode>
);
