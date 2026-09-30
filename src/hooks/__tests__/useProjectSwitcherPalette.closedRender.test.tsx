// @vitest-environment jsdom
/**
 * The switcher hook lives at the app root (via `usePaletteWiring`), and its
 * return value is handed to the unmemoized shell. Every project-stats push —
 * one per agent state change — used to re-render that whole shell even while
 * the switcher was closed. These specs pin the closed palette to zero shell
 * commits under stats traffic, and the open palette to staying live.
 *
 * Set PERF_PROJECT_SWITCHER=<file> to append commit counts and render time to
 * that file.
 */
import { appendFileSync } from "node:fs";
import { Profiler, useLayoutEffect, type ProfilerOnRenderCallback } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectStatusMap } from "@shared/types/ipc/project";

const PROJECT_COUNT = 30;
const PUSHES = 50;

vi.mock("@/clients", () => ({
  projectClient: {
    prefetchHydrate: vi.fn().mockResolvedValue(undefined),
    getBulkStats: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue(undefined),
  },
  scratchClient: {
    saveAsProject: vi.fn().mockResolvedValue({ status: "cancelled" }),
  },
  projectPresenceClient: {
    getSnapshot: vi.fn(() => Promise.resolve({ thisWindow: [], otherWindows: [] })),
    onChanged: vi.fn(() => () => {}),
  },
}));

vi.mock("@/store/projectStore", async () => {
  const { create } = await import("zustand");
  const projects = Array.from({ length: 30 }, (_, i) => ({
    id: `project-${i}`,
    name: `Project ${i}`,
    path: `/repo/p${i}`,
    emoji: "🌲",
    lastOpened: 1_000 + i,
    frecencyScore: 3.0,
    status: i === 0 ? ("active" as const) : ("background" as const),
  }));
  const useProjectStore = create(() => ({
    projects,
    currentProject: projects[0],
    switchProject: vi.fn().mockResolvedValue(undefined),
    reopenProject: vi.fn().mockResolvedValue(undefined),
    loadProjects: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    closeActiveProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    sleepProject: vi.fn().mockResolvedValue(undefined),
    removeProject: vi.fn().mockResolvedValue(undefined),
    openCloneRepoDialog: vi.fn(),
  }));
  return { useProjectStore };
});

vi.mock("@/store/scratchStore", () => {
  const state = {
    scratches: [],
    currentScratch: null,
    loadScratches: vi.fn().mockResolvedValue(undefined),
    createScratch: vi.fn().mockResolvedValue({ id: "s1" }),
    switchScratch: vi.fn().mockResolvedValue(undefined),
    removeScratch: vi.fn().mockResolvedValue(undefined),
    renameScratch: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useScratchStore: Object.assign(
      vi.fn((selector?: (s: unknown) => unknown) => (selector ? selector(state) : state)),
      { getState: () => state }
    ),
  };
});

vi.mock("@/store/projectSettingsStore", () => {
  const state = { loadNotificationOverridesForProjects: vi.fn() };
  return {
    useProjectSettingsStore: Object.assign(
      vi.fn((selector?: (s: unknown) => unknown) => (selector ? selector(state) : state)),
      { getState: () => state }
    ),
  };
});

vi.mock("@/lib/notify", () => ({ notify: vi.fn().mockReturnValue("") }));

import { usePaletteStore } from "@/store/paletteStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectStore } from "@/store/projectStore";
import {
  useProjectSwitcherPalette,
  type UseProjectSwitcherPaletteReturn,
} from "../useProjectSwitcherPalette";

function statsFor(push: number): ProjectStatusMap {
  const stats: ProjectStatusMap = {};
  for (let i = 0; i < PROJECT_COUNT; i++) {
    // One project flips between working and waiting per push, the shape an
    // agent:state-changed broadcast has; every entry is a fresh object as IPC
    // delivers it.
    const flipped = push > 0 && push % 2 === 0 && i === push % PROJECT_COUNT;
    stats[`project-${i}`] = {
      processCount: i % 3,
      activeAgentCount: flipped ? 0 : i % 2,
      waitingAgentCount: flipped ? 1 : 0,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
      snoozedAgentCount: 0,
      ...(flipped ? { oldestWaitingSince: 5_000 + push } : {}),
    };
  }
  return stats;
}

// Stands in for AppLayout: unmemoized, so it re-renders whenever the root does.
function Shell({ palette }: { palette: UseProjectSwitcherPaletteReturn }) {
  return (
    <div data-open={palette.isOpen}>
      {Array.from({ length: 400 }, (_, i) => (
        <span key={i}>{i}</span>
      ))}
    </div>
  );
}

let latest: UseProjectSwitcherPaletteReturn | null = null;
const initialProjects = useProjectStore.getState().projects;

function withEntry(
  stats: ProjectStatusMap,
  id: string,
  entry: Partial<ProjectStatusMap[string]>
): ProjectStatusMap {
  return { ...stats, [id]: { ...stats["project-1"]!, ...entry } };
}

function Root() {
  const palette = useProjectSwitcherPalette();
  useLayoutEffect(() => {
    latest = palette;
  });
  return <Shell palette={palette} />;
}

function mount() {
  const metrics = { commits: 0, duration: 0 };
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    metrics.commits += 1;
    metrics.duration += actualDuration;
  };
  const view = render(
    <Profiler id="app" onRender={onRender}>
      <Root />
    </Profiler>
  );
  return { view, metrics };
}

async function pushStats(count: number, offset = 1) {
  for (let push = offset; push < offset + count; push++) {
    await act(async () => {
      useProjectStatsStore.getState().setStats(statsFor(push));
    });
  }
}

function report(label: string, metrics: { commits: number; duration: number }, wallMs: number) {
  if (!process.env.PERF_PROJECT_SWITCHER) return;
  appendFileSync(
    process.env.PERF_PROJECT_SWITCHER,
    `[perf] ${label}: commits=${metrics.commits} renderMs=${metrics.duration.toFixed(2)} wallMs=${wallMs.toFixed(2)}\n`
  );
}

describe("useProjectSwitcherPalette shell re-renders", () => {
  beforeEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
    useProjectStatsStore.setState({ stats: statsFor(0) });
    latest = null;
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
    useProjectStore.setState({ projects: initialProjects });
  });

  it("does not re-render the shell on stats pushes while the switcher is closed", async () => {
    const { metrics } = mount();
    await act(async () => {});
    metrics.commits = 0;
    metrics.duration = 0;

    const start = performance.now();
    await pushStats(PUSHES);
    report("closed x50 pushes", metrics, performance.now() - start);

    expect(metrics.commits).toBe(0);
  });

  it("keeps rows live on stats pushes while the switcher is open", async () => {
    const { metrics } = mount();
    await act(async () => {});

    const openStart = performance.now();
    await act(async () => {
      latest!.open("modal");
    });
    report("open()", metrics, performance.now() - openStart);
    metrics.commits = 0;
    metrics.duration = 0;

    const start = performance.now();
    await pushStats(PUSHES);
    report("open x50 pushes", metrics, performance.now() - start);

    expect(metrics.commits).toBe(PUSHES);
    const last = statsFor(PUSHES);
    const flippedId = Object.keys(last).find((id) => last[id]!.waitingAgentCount > 0);
    const row = latest!.results.find((r) => r.id === flippedId);
    expect(row && row.kind === "project" ? row.waitingAgentCount : -1).toBe(1);
  });

  it("opens onto the stats that arrived while it was closed", async () => {
    mount();
    await act(async () => {});
    await pushStats(PUSHES);

    await act(async () => {
      latest!.open("modal");
    });

    const last = statsFor(PUSHES);
    for (const row of latest!.results) {
      if (row.kind !== "project") continue;
      expect(row.waitingAgentCount).toBe(last[row.id]!.waitingAgentCount);
      expect(row.processCount).toBe(last[row.id]!.processCount);
    }
    // Bands are frozen at open, so they must have been cut from the fresh
    // stats: the one waiting project sits in Needs attention.
    const flippedId = Object.keys(last).find((id) => last[id]!.waitingAgentCount > 0);
    const flipped = latest!.results.find((r) => r.id === flippedId);
    expect(flipped && flipped.kind === "project" ? flipped.section : null).toBe("attention");
  });

  it("stops re-rendering once closed again, and reopens onto fresh rows", async () => {
    const { metrics } = mount();
    await act(async () => {});
    await act(async () => {
      latest!.open("modal");
    });
    await pushStats(5);
    await act(async () => {
      latest!.close();
    });
    metrics.commits = 0;

    await pushStats(PUSHES, 6);
    expect(metrics.commits).toBe(0);

    await act(async () => {
      latest!.open("dropdown");
    });
    const last = statsFor(PUSHES + 5);
    const projectRows = latest!.results.filter((row) => row.kind === "project");
    expect(projectRows).toHaveLength(PROJECT_COUNT);
    for (const row of projectRows) {
      expect(row.waitingAgentCount).toBe(last[row.id]!.waitingAgentCount);
    }
  });

  it("snapshots current counts when sleep or remove is asked for while closed", async () => {
    mount();
    await act(async () => {});
    await act(async () => {
      useProjectStatsStore
        .getState()
        .setStats(withEntry(statsFor(1), "project-4", { processCount: 7, activeAgentCount: 3 }));
    });

    await act(async () => {
      await latest!.sleepProject("project-4");
    });
    expect(latest!.sleepConfirmProject?.processCount).toBe(7);
    expect(latest!.sleepConfirmProject?.activeAgentCount).toBe(3);

    await act(async () => {
      await latest!.removeProject("project-4");
    });
    expect(latest!.removeConfirmProject?.processCount).toBe(7);
  });

  it("does not band a project that arrives while closed from held stats", async () => {
    mount();
    await act(async () => {});
    await act(async () => {
      latest!.open("modal");
    });
    // Another palette takes the slot, so close() never runs and the session's
    // frozen layout survives into the closed state.
    await act(async () => {
      usePaletteStore.getState().openPalette("action");
    });
    await act(async () => {
      useProjectStatsStore
        .getState()
        .setStats(withEntry(statsFor(1), "project-new", { waitingAgentCount: 1 }));
    });
    await act(async () => {
      useProjectStore.setState({
        projects: [
          ...initialProjects,
          { ...initialProjects[1]!, id: "project-new", name: "New", path: "/repo/new" },
        ],
      });
    });

    await act(async () => {
      usePaletteStore.getState().openPalette("project-switcher");
    });
    const arrival = latest!.results.find((row) => row.id === "project-new");
    expect(arrival && arrival.kind === "project" ? arrival.section : null).toBe("attention");
  });
});
