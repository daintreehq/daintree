import { FROZEN_NOW } from "@/components/Layout/__preview__/bootstrap";
import "@/lib/trustedTypesPolicy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { setPanelStoreAccessor } from "@/store/storeAccessors";
import { usePreferencesStore } from "@/store/preferencesStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { ContentDock } from "@/components/Layout/ContentDock";
import { DockPanelOffscreenContainer } from "@/components/Layout/DockPanelOffscreenContainer";
import { PanelTransitionOverlay } from "../PanelTransitionOverlay";
import { animatePanelMove } from "../animatePanelMove";
import "@/index.css";

/**
 * Standalone visual-review harness for the minimize-to-dock transition.
 *
 * The ghost exists for 120ms, so no human and no screenshot ever sees it at rest. This
 * page mounts the real `PanelTransitionOverlay` and the real `ContentDock` against the
 * real stores and theme tokens, under a stand-in grid whose panes carry the same
 * `data-panel-id` hook the real `ContentPanel` does. The spec installs a fake clock,
 * calls `window.__minimize(id)` or `window.__restore(id)` — the same sequences the
 * grid pane's minimize button and the dock chip's "move to grid" run — and then
 * pauses every animation in the overlay at a chosen point in the flight, so each
 * capture is one frame of the real motion.
 *
 * Opt-in only: `DAINTREE_SHOT_PANELTRANSITION=1`, see panel-transition-review.spec.ts.
 *
 * Query parameters:
 *   ?theme=daintree|namib|svalbard|…   built-in theme id
 *   ?fixture=few|busy                  how full the dock already is
 */

const ACTIVE = "wt-transition";
const WORKTREES: WorktreeSnapshot[] = [
  {
    id: ACTIVE,
    worktreeId: ACTIVE,
    path: "/Users/greg/Projects/daintree-worktrees/design-panel-transition",
    name: "design-panel-transition",
    branch: "design/panel-transition",
    isCurrent: true,
  },
];

type PaneOverrides = Omit<Partial<PtyPanelData>, "kind"> & { kind?: PanelInstance["kind"] };

function pane(id: string, title: string, extra: PaneOverrides = {}): PanelInstance {
  return {
    id,
    title,
    kind: "terminal" as PanelInstance["kind"],
    cwd: WORKTREES[0]!.path,
    cols: 120,
    rows: 40,
    worktreeId: ACTIVE,
    projectId: "proj-daintree",
    location: "grid",
    hasPty: true,
    ...extra,
  } as PanelInstance;
}

function agentPane(
  id: string,
  agentId: "claude" | "codex" | "gemini",
  extra: PaneOverrides = {}
): PanelInstance {
  const name = agentId === "claude" ? "Claude" : agentId === "codex" ? "Codex" : "Gemini";
  return pane(id, name, {
    launchAgentId: agentId,
    detectedAgentId: agentId,
    agentState: "idle",
    lastStateChange: FROZEN_NOW - 90_000,
    ...extra,
  });
}

const GRID: PanelInstance[] = [
  agentPane("p-claude", "claude", { agentState: "working" }),
  agentPane("p-codex", "codex", { lastObservedTitle: "Regenerate the text-ramp manifest" }),
  pane("p-dev", "npm run dev"),
  pane("p-shell", "zsh"),
];

const FIXTURES: Record<string, PanelInstance[]> = {
  few: [...GRID, pane("d-tests", "npm test", { location: "dock" })],
  busy: [
    ...GRID,
    pane("d-files", "Files — design/panel-transition", {
      kind: "file-browser",
      hasPty: false,
      location: "dock",
    }),
    agentPane("d-gemini", "gemini", { location: "dock" }),
    pane("d-tests", "npm test", { location: "dock" }),
    pane("d-lint", "npm run lint", { location: "dock" }),
    pane("d-logs", "tail -f main.log", { location: "dock" }),
  ],
};

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "few";
const panels = FIXTURES[fixtureName];
if (!panels) throw new Error(`unknown fixture "${fixtureName}"`);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
setCurrentViewStore(worktreeStore);
useWorktreeSelectionStore.setState({ activeWorktreeId: ACTIVE });
usePreferencesStore.setState({ dockDensity: "normal" });
usePluginContextMenuItemsStore.setState({ entries: [], init() {} });
// Registered by the store orchestrator at app boot; the transition reads the store through it.
setPanelStoreAccessor(() => {
  const s = usePanelStore.getState();
  return { panelsById: s.panelsById, panelIds: s.panelIds, tabGroups: s.tabGroups };
});
usePanelStore.setState({
  panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
  panelIds: panels.map((p) => p.id),
  trashedTerminals: new Map(),
  tabGroups: new Map(),
});

/** The grid pane's minimize button and the dock chip's "move to grid", as the app runs them. */
function minimize(panelId: string): void {
  animatePanelMove(panelId, "minimize", () => usePanelStore.getState().moveTerminalToDock(panelId));
}

function restore(panelId: string): void {
  animatePanelMove(panelId, "restore", () => usePanelStore.getState().moveTerminalToGrid(panelId));
}

/**
 * Pause every animation inside the overlay portal at
 * `progress` of the longest one's end time, so each is shown at the same instant of the
 * flight. Forces a style flush first so a CSS transition that was armed this frame
 * exists as an Animation before it is looked for. Returns how many it froze.
 */
function freeze(progress: number): number {
  const overlay = document.querySelector("[data-panel-transition-overlay]");
  if (!overlay) return 0;
  for (const node of [overlay, ...overlay.querySelectorAll("*")])
    void getComputedStyle(node).opacity;
  const animations = document.getAnimations().filter((a) => {
    const effect = a.effect;
    return (
      effect instanceof KeyframeEffect &&
      effect.target instanceof Element &&
      overlay.contains(effect.target)
    );
  });
  const end = Math.max(
    0,
    ...animations.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0))
  );
  for (const a of animations) {
    a.pause();
    a.currentTime = progress * end;
  }
  return animations.length;
}

Object.assign(window, { __minimize: minimize, __restore: restore, __freeze: freeze });

function StandInPane({ id }: { id: string }) {
  const panel = usePanelStore(useShallow((s) => s.panelsById[id]));
  if (!panel) return null;
  const lines =
    panel.title === "npm run dev"
      ? ["> vite", "", "  VITE v8.0.14  ready in 412 ms", "  ➜  Local:   http://localhost:5173/"]
      : panel.title === "zsh"
        ? [
            "~/P/daintree-worktrees/design-panel-transition",
            "❯ git status --short",
            " M src/components/Panel/PanelTransitionOverlay.tsx",
            "❯ ",
          ]
        : [
            "● Reading src/components/Panel/PanelTransitionOverlay.tsx",
            "● Reading src/components/Terminal/GridPanel.tsx",
            "",
            "  The ghost measures the pane, then flies toward the dock.",
          ];
  return (
    <div
      data-panel-id={id}
      data-panel-location="grid"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs text-text-secondary">
        <span className="truncate text-text-primary">{panel.title}</span>
      </div>
      <pre className="m-0 min-h-0 flex-1 overflow-hidden p-3 font-mono text-xs leading-5 text-text-secondary">
        {lines.join("\n")}
      </pre>
    </div>
  );
}

function StandInGrid() {
  const gridIds = usePanelStore(
    useShallow((s) => s.panelIds.filter((id) => s.panelsById[id]?.location === "grid"))
  );
  const cols = gridIds.length > 2 ? 2 : Math.max(1, gridIds.length);
  return (
    <div
      data-harness-decoration
      className="grid min-h-0 flex-1 gap-2 p-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {gridIds.map((id) => (
        <StandInPane key={id} id={id} />
      ))}
    </div>
  );
}

function Frame() {
  return (
    <div
      data-preview-shell
      data-fixture={fixtureName}
      className="flex bg-surface-canvas"
      style={{ width: "1280px", height: "680px" }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex w-[220px] shrink-0 flex-col gap-2 border-r border-divider bg-surface-sidebar p-3"
      >
        <div className="rounded-[var(--radius-md)] bg-overlay-medium px-3 py-2 text-xs text-text-primary">
          {WORKTREES[0]!.branch}
        </div>
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-canvas">
        <StandInGrid />
        <aside aria-label="Dock" data-dock-frame>
          <DockPanelOffscreenContainer>
            <ContentDock density="normal" />
          </DockPanelOffscreenContainer>
        </aside>
      </main>
      <PanelTransitionOverlay />
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
