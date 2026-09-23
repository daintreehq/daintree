import { FROZEN_NOW } from "./bootstrap";
// The app registers its Trusted Types policies at boot (main.tsx); the dev CSP
// stamped on this entry enforces them, and the dock's module graph has sinks.
import "@/lib/trustedTypesPolicy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore, type DockDensity } from "@/store/preferencesStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { WaitingReason } from "@shared/types/agent";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { TrashedTerminal } from "@/store/slices";
import type { TabGroup } from "@/types";
import { ContentDock } from "../ContentDock";
import { DockPanelOffscreenContainer } from "../DockPanelOffscreenContainer";
import "@/index.css";

/**
 * Standalone visual-review harness for the whole content dock.
 *
 * The dock mixes two scopes on one strip: the chips belong to the active
 * worktree, while the Background / Waiting / Errors / Trash pills read across
 * every worktree in the project. Photographing that honestly needs panels in
 * several worktrees at once — agents waiting elsewhere, trash from elsewhere —
 * which is slow to stage in the real app and impossible to hold still. This
 * mounts the real `ContentDock` against the real stores and theme tokens,
 * under a stand-in sidebar and grid so the strip sits where it sits in the app.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DOCK=1 npx playwright test --project=screenshots dock-review
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=rest             which workspace to render (see FIXTURES)
 *   ?width=1440               frame width in CSS px
 *   ?density=normal           compact | normal | comfortable
 */

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-dock",
    worktreeId: "wt-dock",
    path: "/Users/greg/Projects/daintree-worktrees/design-dock",
    name: "design-dock",
    branch: "design/dock",
    isCurrent: true,
  },
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
    id: "wt-12383",
    worktreeId: "wt-12383",
    path: "/Users/greg/Projects/daintree-worktrees/issue-12383",
    name: "issue-12383",
    branch: "bugfix/issue-12383-menu-rows-show-keyboard-focus",
    isCurrent: false,
  },
  {
    id: "wt-thumbs",
    worktreeId: "wt-thumbs",
    path: "/Users/greg/Projects/daintree-worktrees/thumbnails",
    name: "thumbnails",
    branch: "feature/thumbnails",
    isCurrent: false,
  },
];

const ACTIVE = "wt-dock";

type PaneOverrides = Omit<Partial<PtyPanelData>, "kind"> & { kind?: PanelInstance["kind"] };

function pane(id: string, title: string, extra: PaneOverrides = {}): PanelInstance {
  return {
    id,
    title,
    kind: "terminal" as PanelInstance["kind"],
    cwd: "/Users/greg/Projects/daintree-worktrees/design-dock",
    cols: 120,
    rows: 40,
    worktreeId: ACTIVE,
    projectId: "proj-daintree",
    location: "dock",
    hasPty: true,
    ...extra,
  } as PanelInstance;
}

function agent(
  id: string,
  agentId: "claude" | "codex" | "gemini",
  extra: PaneOverrides = {}
): PaneOverrides & { id: string } {
  const name = agentId === "claude" ? "Claude" : agentId === "codex" ? "Codex" : "Gemini";
  return {
    id,
    title: name,
    launchAgentId: agentId,
    detectedAgentId: agentId,
    agentState: "idle",
    lastStateChange: FROZEN_NOW - 90_000,
    ...extra,
  };
}

function waiting(minutesAgo: number, reason: WaitingReason = "prompt"): PaneOverrides {
  return {
    agentState: "waiting",
    waitingReason: reason,
    lastStateChange: FROZEN_NOW - minutesAgo * 60_000,
  };
}

function fromAgent(spec: PaneOverrides & { id: string }): PanelInstance {
  const { id, title, ...rest } = spec;
  return pane(id, title ?? id, rest);
}

const filesChip = pane("p-files", "Files — design/dock", { kind: "file-browser", hasPty: false });
const claudeWaitingHere = fromAgent(agent("p-claude", "claude", waiting(3)));
const shell = pane("p-shell", "Terminal");

/** Agents in OTHER worktrees, parked in their grids — only the global pills see them. */
function elsewhere(): PanelInstance[] {
  return [
    fromAgent(
      agent("x-1", "codex", { ...waiting(12, "approval"), worktreeId: "wt-main", location: "grid" })
    ),
    fromAgent(
      agent("x-2", "claude", {
        ...waiting(8, "question"),
        worktreeId: "wt-12383",
        location: "grid",
        lastObservedTitle: "Stop menu rows showing focus on hover",
      })
    ),
    fromAgent(agent("x-3", "gemini", { ...waiting(6), worktreeId: "wt-12383", location: "grid" })),
    fromAgent(agent("x-4", "claude", { ...waiting(4), worktreeId: "wt-thumbs", location: "grid" })),
    fromAgent(agent("x-5", "codex", { ...waiting(2), worktreeId: "wt-thumbs", location: "grid" })),
    fromAgent(agent("x-6", "claude", { ...waiting(1), worktreeId: "wt-main", location: "grid" })),
  ];
}

interface Fixture {
  what: string;
  panels: PanelInstance[];
  trashed?: Array<{ id: string; secondsLeft: number }>;
  tabGroups?: TabGroup[];
}

function trashedPane(id: string, title: string, worktreeId: string): PanelInstance {
  return pane(id, title, { worktreeId, location: "trash" });
}

const FIXTURES: Record<string, Fixture> = {
  rest: {
    what: "the reported state — three local chips, seven waiting project-wide, one in trash",
    panels: [
      filesChip,
      claudeWaitingHere,
      shell,
      ...elsewhere(),
      trashedPane("tr-1", "npm run dev", "wt-main"),
    ],
    trashed: [{ id: "tr-1", secondsLeft: 14 }],
  },
  busy: {
    what: "a full rail — working agents, a tab group, every global pill lit",
    panels: [
      filesChip,
      claudeWaitingHere,
      fromAgent(
        agent("p-codex", "codex", {
          agentState: "working",
          lastObservedTitle: "Regenerate the text-ramp manifest",
        })
      ),
      fromAgent(agent("p-gemini", "gemini", { agentState: "working" })),
      pane("p-dev", "npm run dev", {}),
      pane("p-g1", "npm test", {}),
      pane("p-g2", "zsh", {}),
      pane("p-browser", "localhost:5173", {
        kind: "browser",
        hasPty: false,
        browserUrl: "http://localhost:5173",
      }),
      shell,
      ...elsewhere().slice(0, 3),
      fromAgent(
        agent("x-err", "codex", {
          agentState: "exited",
          exitCode: 1,
          worktreeId: "wt-thumbs",
          location: "grid",
        })
      ),
      fromAgent(agent("x-bg", "claude", { worktreeId: "wt-main", location: "background" })),
      trashedPane("tr-1", "npm run dev", "wt-main"),
      trashedPane("tr-2", "Codex", "wt-12383"),
      trashedPane("tr-3", "zsh", ACTIVE),
    ],
    trashed: [
      { id: "tr-1", secondsLeft: 14 },
      { id: "tr-2", secondsLeft: 9 },
      { id: "tr-3", secondsLeft: 4 },
    ],
    tabGroups: [
      {
        id: "g-tests",
        panelIds: ["p-g1", "p-g2"],
        activeTabId: "p-g1",
        location: "dock",
        worktreeId: ACTIVE,
      } as TabGroup,
    ],
  },
  "empty-local": {
    what: "nothing docked in this worktree, but agents waiting in others",
    panels: [...elsewhere().slice(0, 4)],
  },
  "local-only": {
    what: "chips here, nothing happening anywhere else — no global pills",
    panels: [filesChip, fromAgent(agent("p-claude", "claude")), shell],
  },
  "waiting-here-only": {
    what: "the single waiting agent is the local chip itself — pill and chip name the same thing",
    panels: [filesChip, claudeWaitingHere, shell],
  },
  // The Waiting popover's own states — `waiting-popover-review` opens each one.
  "waiting-three-here": {
    what: "three identical agents waiting in this worktree, nothing elsewhere",
    panels: [
      fromAgent(agent("h-1", "claude", { ...waiting(0.45), location: "grid" })),
      fromAgent(agent("h-2", "claude", { ...waiting(0.45), location: "grid" })),
      fromAgent(agent("h-3", "claude", { ...waiting(0.45), location: "grid" })),
    ],
  },
  "waiting-split": {
    what: "one here, three in another worktree",
    panels: [
      fromAgent(agent("h-1", "claude", { ...waiting(0.2), location: "grid" })),
      fromAgent(agent("e-1", "claude", { ...waiting(1), worktreeId: "wt-main", location: "grid" })),
      fromAgent(agent("e-2", "claude", { ...waiting(1), worktreeId: "wt-main", location: "grid" })),
      fromAgent(agent("e-3", "claude", { ...waiting(1), worktreeId: "wt-main", location: "grid" })),
    ],
  },
  "waiting-reasons": {
    what: "every reason chip, task titles, a long worktree name and an activity headline",
    panels: [
      fromAgent(
        agent("h-1", "claude", {
          ...waiting(2, "approval"),
          location: "grid",
          lastObservedTitle: "Tighten the waiting popover rows",
        })
      ),
      fromAgent(agent("h-2", "codex", { ...waiting(14), location: "grid" })),
      fromAgent(
        agent("e-1", "codex", {
          ...waiting(9, "error"),
          worktreeId: "wt-12383",
          location: "grid",
          activityHeadline: "npm test failed in 4 files",
        })
      ),
      fromAgent(
        agent("e-2", "gemini", {
          ...waiting(6, "question"),
          worktreeId: "wt-thumbs",
          location: "grid",
          lastObservedTitle: "Generate thumbnails for the project switcher",
        })
      ),
      fromAgent(agent("e-3", "claude", { ...waiting(72), worktreeId: "wt-main", location: "grid" })),
    ],
  },
  "waiting-group": {
    what: "a tab group with two waiting members beside single rows",
    panels: [
      fromAgent(agent("g-1", "claude", { ...waiting(3, "question"), location: "dock" })),
      fromAgent(agent("g-2", "codex", { ...waiting(1), location: "dock" })),
      fromAgent(agent("h-1", "gemini", { ...waiting(5), location: "grid" })),
      fromAgent(agent("e-1", "claude", { ...waiting(2), worktreeId: "wt-main", location: "grid" })),
    ],
    tabGroups: [
      {
        id: "g-waiting",
        panelIds: ["g-1", "g-2"],
        activeTabId: "g-1",
        location: "dock",
        worktreeId: ACTIVE,
      } as TabGroup,
    ],
  },
  "waiting-many": {
    what: "twelve waiting across four worktrees — the list scrolls",
    panels: Array.from({ length: 12 }, (_, i) =>
      fromAgent(
        agent(`m-${i}`, (["claude", "codex", "gemini"] as const)[i % 3]!, {
          ...waiting(i * 3 + 1, i === 0 ? "approval" : "prompt"),
          worktreeId: WORKTREES[i % 4]!.id,
          location: "grid",
        })
      )
    ),
  },
};

export const DOCK_FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "rest";
const width = Number(params.get("width")) || 1440;
const DENSITIES: readonly DockDensity[] = ["compact", "normal", "comfortable"];
const density: DockDensity = DENSITIES.find((d) => d === params.get("density")) ?? "normal";

const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(
    `unknown fixture "${fixtureName}" — expected one of ${DOCK_FIXTURE_NAMES.join(", ")}`
  );
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.documentElement.style.height = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
setCurrentViewStore(worktreeStore);

const trashedTerminals = new Map<string, TrashedTerminal>(
  (fixture.trashed ?? []).map(({ id, secondsLeft }) => [
    id,
    { id, expiresAt: FROZEN_NOW + secondsLeft * 1000, originalLocation: "grid" },
  ])
);

// Seeded before the first render so nothing photographs an arrival.
useWorktreeSelectionStore.setState({ activeWorktreeId: ACTIVE });
usePreferencesStore.setState({ dockDensity: density });
// The shimmed bridge resolves `undefined` where the plugin menu store expects an
// array, and every chip's context menu reads it on render.
usePluginContextMenuItemsStore.setState({ entries: [], init() {} });
usePanelStore.setState({
  panelsById: Object.fromEntries(fixture.panels.map((p) => [p.id, p])),
  panelIds: fixture.panels.map((p) => p.id),
  trashedTerminals,
  tabGroups: new Map((fixture.tabGroups ?? []).map((g) => [g.id, g])),
});

/** Stand-in chrome, so the strip sits where it sits in the app. */
function Frame() {
  return (
    <div
      data-preview-shell
      data-fixture={fixtureName}
      className="flex bg-surface-canvas"
      style={{ width: `${width}px`, height: "600px" }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex w-[260px] shrink-0 flex-col gap-2 border-r border-divider bg-surface-sidebar p-3"
      >
        {WORKTREES.map((w) => (
          <div
            key={w.id}
            className={
              w.id === ACTIVE
                ? "rounded-[var(--radius-md)] bg-overlay-medium px-3 py-2 text-xs text-text-primary"
                : "rounded-[var(--radius-md)] px-3 py-2 text-xs text-text-secondary"
            }
          >
            {w.branch}
          </div>
        ))}
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-canvas">
        <div
          data-harness-decoration
          aria-hidden="true"
          className="grid min-h-0 flex-1 grid-cols-2 gap-2 p-2"
        >
          <div className="rounded-[var(--radius-md)] border border-divider bg-surface-panel" />
          <div className="rounded-[var(--radius-md)] border border-divider bg-surface-panel" />
        </div>
        <aside aria-label="Dock" data-dock-frame>
          <DockPanelOffscreenContainer>
            <ContentDock density={density} />
          </DockPanelOffscreenContainer>
        </aside>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <DndContext>
          <Frame />
        </DndContext>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  </StrictMode>
);
