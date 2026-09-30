// @vitest-environment jsdom
/**
 * Render-count bench for the always-mounted dock and launcher consumers.
 *
 * Mounts the real ContentDock (20 docked panels: 14 terminals, two 2-tab
 * groups, two browser chips) beside the real Toolbar, then drives the two
 * churn sources those components should not care about: git-status snapshot
 * updates for worktrees other than the active one, and dock popover
 * open/close toggles. Reports renders per component, React commits, render
 * time (Profiler actualDuration) and wall-clock time for the driven updates
 * (store writes, selectors, render and commit), as medians over repeated mounts.
 *
 *   npx vitest run -c src/components/Layout/__bench__/vitest.config.ts
 */
import "../__preview__/toolbarShims";
import { Profiler } from "react";
import { describe, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { AgentSettings, CliAvailability, WorktreeSnapshot } from "@shared/types";
import type { PanelInstance, PtyPanelData, TabGroup } from "@shared/types/panel";

const renders = vi.hoisted(() => new Map<string, number>());
const bump = vi.hoisted(() => (key: string) => renders.set(key, (renders.get(key) ?? 0) + 1));

function counted<M extends Record<string, unknown>>(actual: M, name: keyof M & string, key = name) {
  const Component = actual[name] as (props: unknown) => unknown;
  return {
    ...actual,
    [name]: (props: unknown) => {
      bump(key);
      return Component(props);
    },
  };
}

vi.mock("../DockedTerminalItem", async (o) =>
  counted(await o<Record<string, unknown>>(), "DockedTerminalItem")
);
vi.mock("../DockedNonPtyPanelItem", async (o) =>
  counted(await o<Record<string, unknown>>(), "DockedNonPtyPanelItem")
);
vi.mock("../DockedTabGroup", async (o) =>
  counted(await o<Record<string, unknown>>(), "DockedTabGroup")
);
vi.mock("../BackgroundContainer", async (o) =>
  counted(await o<Record<string, unknown>>(), "BackgroundContainer")
);
vi.mock("../WaitingContainer", async (o) =>
  counted(await o<Record<string, unknown>>(), "WaitingContainer")
);
vi.mock("../TrashContainer", async (o) =>
  counted(await o<Record<string, unknown>>(), "TrashContainer")
);
vi.mock("../StatusContainer", async (o) =>
  counted(await o<Record<string, unknown>>(), "StatusContainer", "ErrorsContainer")
);
vi.mock("../ContentDock", async (o) => counted(await o<Record<string, unknown>>(), "ContentDock"));
// The preview bridge answers the plugin menu pull with `undefined`.
vi.mock("@/hooks/usePluginContextMenuItems", () => {
  const none: never[] = [];
  return { usePluginContextMenuItems: () => none };
});
// Called exactly once per Toolbar render.
vi.mock("@/hooks/useToolbarOverflow", async (o) => {
  const actual = await o<typeof import("@/hooks/useToolbarOverflow")>();
  return {
    ...actual,
    useToolbarOverflow: (...args: Parameters<typeof actual.useToolbarOverflow>) => {
      bump("Toolbar");
      return actual.useToolbarOverflow(...args);
    },
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { PREVIEW_PROJECT } from "../__preview__/toolbarShims";
import { Toolbar } from "../Toolbar";
import { ContentDock } from "../ContentDock";
import { DockPanelContext, type DockPanelContextValue } from "../dockPanelPortalContext";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";

const AGENTS = ["claude", "codex", "gemini"] as const;
const WORKTREES = 10;
const SNAPSHOT_UPDATES = 100;
const POPOVER_TOGGLES = 20;
const REPEATS = Number(process.env.DOCK_BENCH_REPEATS ?? 5);

function worktree(i: number): WorktreeSnapshot {
  const id = i === 0 ? "wt-main" : `wt-${i}`;
  return {
    id,
    worktreeId: id,
    path: i === 0 ? PREVIEW_PROJECT.path : `${PREVIEW_PROJECT.path}-wt-${i}`,
    name: i === 0 ? "main" : `feature-${i}`,
    branch: i === 0 ? "develop" : `feature/${i}`,
    isCurrent: i === 0,
    isMainWorktree: i === 0,
  } as WorktreeSnapshot;
}

function terminal(id: string, agentId: string | undefined): PtyPanelData {
  return {
    id,
    title: agentId ?? "shell",
    kind: "terminal",
    cwd: PREVIEW_PROJECT.path,
    cols: 120,
    rows: 40,
    worktreeId: "wt-main",
    location: "dock",
    hasPty: true,
    ...(agentId ? { detectedAgentId: agentId, launchAgentId: agentId, agentState: "working" } : {}),
    runtimeStatus: "running",
  } as PtyPanelData;
}

function browser(id: string): PanelInstance {
  return {
    id,
    title: `Browser ${id}`,
    kind: "browser",
    worktreeId: "wt-main",
    location: "dock",
    browserUrl: "http://localhost:3000",
  } as PanelInstance;
}

const noop = () => {};
const dockPanelContext: DockPanelContextValue = {
  moveToDestination: noop,
  registerDragHandle: () => noop,
};

function Harness(props: { availability: CliAvailability; settings: AgentSettings }) {
  const projectSwitcherPalette = useProjectSwitcherPalette();
  return (
    <>
      <Toolbar
        onLaunchAgent={noop}
        onSettings={noop}
        hasWorkspace
        agentAvailability={props.availability}
        agentSettings={props.settings}
        projectSwitcherPalette={projectSwitcherPalette}
      />
      <DndContext>
        <DockPanelContext.Provider value={dockPanelContext}>
          <ContentDock />
        </DockPanelContext.Provider>
      </DndContext>
    </>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

interface RunResult {
  renders: Record<string, number>;
  renderMs: number;
  wallMs: number;
  commits: number;
}

async function runOnce(phase: "snapshots" | "popovers"): Promise<RunResult> {
  initBuiltInPanelKinds();
  const worktreeStore = createWorktreeStore();
  worktreeStore.setState({
    worktrees: new Map(Array.from({ length: WORKTREES }, (_, i) => [worktree(i).id, worktree(i)])),
  } as never);
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });
  const availability = Object.fromEntries(AGENTS.map((id) => [id, "ready"])) as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData: true });
  const settings = {
    agents: Object.fromEntries(AGENTS.map((id) => [id, { pinned: true }])),
  } as AgentSettings;
  useAgentSettingsStore.setState({ settings });

  const panels: PanelInstance[] = [];
  for (let i = 0; i < 14; i++)
    panels.push(terminal(`term-${i}`, i % 2 ? AGENTS[i % 3] : undefined));
  for (let i = 0; i < 4; i++) panels.push(terminal(`grp-${i}`, AGENTS[i % 3]));
  panels.push(browser("browser-0"), browser("browser-1"));
  const tabGroups = new Map<string, TabGroup>([
    [
      "group-a",
      {
        id: "group-a",
        location: "dock",
        worktreeId: "wt-main",
        activeTabId: "grp-0",
        panelIds: ["grp-0", "grp-1"],
      },
    ],
    [
      "group-b",
      {
        id: "group-b",
        location: "dock",
        worktreeId: "wt-main",
        activeTabId: "grp-2",
        panelIds: ["grp-2", "grp-3"],
      },
    ],
  ]);
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: { "wt-main": panels.map((p) => p.id) },
    tabGroups,
    activeDockTerminalId: null,
  });

  let renderMs = 0;
  let commits = 0;
  const onRender = (_id: string, _phase: string, actualDuration: number) => {
    renderMs += actualDuration;
    commits++;
  };

  render(
    <Profiler id="bench" onRender={onRender}>
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={worktreeStore}>
          <Harness availability={availability} settings={settings} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    </Profiler>
  );
  await settle();
  renders.clear();
  renderMs = 0;
  commits = 0;

  const start = performance.now();
  if (phase === "snapshots") {
    for (let n = 0; n < SNAPSHOT_UPDATES; n++) {
      const i = 1 + (n % (WORKTREES - 1));
      act(() => {
        worktreeStore.setState((s) => {
          const next = new Map(s.worktrees);
          const prev = next.get(`wt-${i}`)!;
          next.set(`wt-${i}`, {
            ...prev,
            lastActivityTimestamp: 1_700_000_000_000 + n,
            worktreeChanges: { changedFileCount: n, changes: [] } as never,
          });
          return { worktrees: next };
        });
      });
    }
  } else {
    // Pure store-level open/close: every chip's `isOpen` is derived from
    // `activeDockTerminalId`, so this is what each toggle fans out to.
    const targets = ["term-0", "term-3", "grp-0", "browser-0"];
    for (let n = 0; n < POPOVER_TOGGLES; n++) {
      const id = targets[n % targets.length]!;
      act(() => usePanelStore.setState({ activeDockTerminalId: id }));
      act(() => usePanelStore.setState({ activeDockTerminalId: null }));
    }
  }
  const wallMs = performance.now() - start;
  await settle();

  const result = { renders: Object.fromEntries(renders), renderMs, wallMs, commits };
  cleanup();
  return result;
}

const KEYS = [
  "ContentDock",
  "Toolbar",
  "DockedTerminalItem",
  "DockedTabGroup",
  "DockedNonPtyPanelItem",
  "BackgroundContainer",
  "WaitingContainer",
  "ErrorsContainer",
  "TrashContainer",
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe("dock subscriber bench", () => {
  for (const phase of ["snapshots", "popovers"] as const) {
    it(`${phase}`, { timeout: 120_000 }, async () => {
      // One warm-up run so JIT and module init stay out of the timing.
      await runOnce(phase);
      const runs: RunResult[] = [];
      for (let r = 0; r < REPEATS; r++) runs.push(await runOnce(phase));
      const rows: Record<string, string | number> = {};
      for (const key of KEYS) rows[`renders:${key}`] = median(runs.map((r) => r.renders[key] ?? 0));
      rows["commits"] = median(runs.map((r) => r.commits));
      rows["render ms (median)"] = median(runs.map((r) => r.renderMs)).toFixed(1);
      rows["render ms (all)"] = runs.map((r) => r.renderMs.toFixed(1)).join(" ");
      rows["wall ms (median)"] = median(runs.map((r) => r.wallMs)).toFixed(1);
      rows["wall ms (all)"] = runs.map((r) => r.wallMs.toFixed(1)).join(" ");
      process.stdout.write(`\n[dock-bench] ${phase}\n${JSON.stringify(rows, null, 2)}\n`);
    });
  }
});
