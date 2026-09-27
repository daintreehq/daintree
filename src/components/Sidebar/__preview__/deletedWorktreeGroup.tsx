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
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { SidebarContent } from "../SidebarContent";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { AgentState, Project } from "@shared/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { PtyPanelData } from "@shared/types/panel";
import "@/index.css";

/**
 * Standalone visual-review harness for the deleted-worktree rows: the lone
 * `DeletedWorktreeCard` and the `DeletedWorktreeGroup` summary that replaces
 * several of them, collapsed (with its rail of rescuable terminals) and
 * expanded.
 *
 * A deleted row only exists after an agent removes its own worktree while its
 * terminals are still running, and it lives for a minute. So this renders the
 * REAL `SidebarContent` against seeded stores, between live worktree rows, so
 * the ghost rows are judged against the neighbours they have to read apart
 * from.
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
  {
    id: "wt-sidebar",
    worktreeId: "wt-sidebar",
    path: "/Users/greg/Projects/daintree-worktrees/design-deleted-worktree-group",
    name: "design-deleted-worktree-group",
    branch: "design/deleted-worktree-group",
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

interface TerminalSeed {
  id: string;
  title: string;
  agent?: BuiltInAgentId;
  state?: AgentState;
  location?: "grid" | "dock";
}

interface DeletedSeed {
  id: string;
  title: string;
  terminals: TerminalSeed[];
  holdReason?: DeletedWorktree["holdReason"];
}

const COHORT: DeletedSeed[] = [
  {
    id: "/Users/greg/Projects/daintree-worktrees/issue-12501-mcp-tier",
    title: "feature/issue-12501-mcp-tier",
    terminals: [
      { id: "t-claude-a", title: "Claude", agent: "claude", state: "working" },
      { id: "t-shell-a", title: "zsh", location: "dock" },
    ],
  },
  {
    id: "/Users/greg/Projects/daintree-worktrees/issue-12517-dock-parking",
    title: "fix/issue-12517-dock-parking",
    terminals: [{ id: "t-codex-b", title: "Codex", agent: "codex", state: "waiting" }],
  },
  {
    id: "/Users/greg/Projects/daintree-worktrees/issue-12533-notify-routing",
    title: "feature/issue-12533-notify-routing-and-grid-bar-placement",
    terminals: [
      { id: "t-gemini-c", title: "Gemini", agent: "gemini", state: "completed" },
      { id: "t-npm-c", title: "npm run dev" },
    ],
  },
];

interface Fixture {
  what: string;
  deleted: DeletedSeed[];
  expanded?: boolean;
  /** Seconds left on every armed row; null leaves the rows unarmed. */
  remaining: number | null;
  cleanupSeconds?: 0 | 30 | 60 | 300;
  holdReason?: DeletedWorktree["holdReason"];
}

const FIXTURES: Record<string, Fixture> = {
  /** Three deletions at once: the summary row and its terminal rail. */
  "group-collapsed": {
    what: "three deleted worktrees, collapsed",
    deleted: COHORT,
    remaining: 42,
  },
  /** The same cohort opened up — the cards the summary stands in for. */
  "group-expanded": {
    what: "three deleted worktrees, expanded",
    deleted: COHORT,
    expanded: true,
    remaining: 42,
  },
  /** Auto-cleanup switched off in settings: no countdown anywhere. */
  "group-no-cleanup": {
    what: "collapsed group with auto-cleanup off",
    deleted: COHORT,
    remaining: null,
    cleanupSeconds: 0,
  },
  /** One member held by its working agent while the others count down. */
  "group-held": {
    what: "collapsed group, one member held by a working agent",
    deleted: [{ ...COHORT[0]!, holdReason: "agent" }, COHORT[1]!, COHORT[2]!],
    remaining: 42,
  },
  /** The smallest group: two rows, one terminal each. */
  "group-pair": {
    what: "two deleted worktrees, one terminal each",
    deleted: [
      { ...COHORT[1]!, terminals: [COHORT[1]!.terminals[0]!] },
      { ...COHORT[2]!, terminals: [COHORT[2]!.terminals[1]!] },
    ],
    remaining: 9,
  },
  /** A single deleted worktree keeps the full card. */
  single: {
    what: "one deleted worktree, standalone card",
    deleted: [COHORT[0]!],
    remaining: 42,
  },
  /** A standalone card whose countdown is held by a working agent. */
  "single-held": {
    what: "one deleted worktree, countdown held by an agent",
    deleted: [COHORT[0]!],
    remaining: 37,
    holdReason: "agent",
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "350");
const fixtureName = params.get("fixture") ?? "group-collapsed";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function terminal(seed: TerminalSeed, worktreeId: string, cwd: string): PtyPanelData {
  return {
    id: seed.id,
    title: seed.title,
    kind: "terminal",
    cwd,
    cols: 120,
    rows: 40,
    worktreeId,
    location: seed.location ?? "grid",
    hasPty: true,
    runtimeStatus: "running",
    ...(seed.agent
      ? {
          detectedAgentId: seed.agent,
          launchAgentId: seed.agent,
          agentState: seed.state ?? "idle",
        }
      : {}),
  };
}

const LIVE_TERMINALS: Record<string, TerminalSeed[]> = {
  "wt-sidebar": [
    { id: "t-live-claude", title: "Claude", agent: "claude", state: "working" },
    { id: "t-live-shell", title: "zsh" },
  ],
};

function seedStores() {
  initBuiltInPanelKinds();

  const store = createWorktreeStore();
  store.setState({
    worktrees: new Map(LIVE.map((w) => [w.id, w])),
    isLoading: false,
    isInitialized: true,
    error: null,
  });
  setCurrentViewStore(store);
  useProjectStore.setState({ currentProject: PROJECT, worktreeLoadError: null });

  const panels: PtyPanelData[] = [];
  const byWorktree: Record<string, string[]> = {};
  for (const [worktreeId, seeds] of Object.entries(LIVE_TERMINALS)) {
    const cwd = LIVE.find((w) => w.id === worktreeId)!.path;
    const list = seeds.map((s) => terminal(s, worktreeId, cwd));
    panels.push(...list);
    byWorktree[worktreeId] = list.map((p) => p.id);
  }
  for (const d of fixture!.deleted) {
    const list = d.terminals.map((s) => terminal(s, d.id, d.id));
    panels.push(...list);
    byWorktree[d.id] = list.map((p) => p.id);
  }
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: byWorktree,
  });

  const cleanupSeconds = fixture!.cleanupSeconds ?? 60;
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: cleanupSeconds });

  const now = Date.now();
  // Anchored before the last live row, so the ghosts sit between live
  // neighbours rather than trailing the list with nothing below them.
  const deleted = new Map<string, DeletedWorktree>(
    fixture!.deleted.map((d, i) => [
      d.id,
      {
        id: d.id,
        title: d.title,
        path: d.id,
        deletedAt: now - 5_000 - i * 1_000,
        expiresAt:
          fixture!.remaining === null || cleanupSeconds === 0
            ? null
            : now + (fixture!.remaining + i * 6) * 1000 + 500,
        holdReason: d.holdReason ?? fixture!.holdReason ?? null,
        pinnedBeforeWorktreeId: "wt-handback",
      },
    ])
  );
  useWorktreeSelectionStore.setState({
    activeWorktreeId: "wt-sidebar",
    deletedWorktrees: deleted,
    deletedWorktreeGroupExpanded: fixture!.expanded ?? false,
  });
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => undefined });
  return store;
}

const store = seedStores();

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
