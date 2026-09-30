// @vitest-environment jsdom
/**
 * While the overview is open, streaming agents rewrite their panels' activity
 * headline on every flush. The modal's per-worktree meta (chip state, counts,
 * filtering, sorting) reads only agent state and visibility, so those writes
 * must not recompute it or re-render the modal. Mounts the real modal with
 * 30 worktrees × 30 agents. Prints metrics with OVERVIEW_ACTIVITY_BENCH=1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeState } from "@shared/types";

const chipStateCalls = vi.hoisted(() => ({ count: 0, waitingCounts: [] as number[] }));

// Called once per worktree per meta recompute, so it counts the recomputes.
vi.mock("@/components/Worktree/utils/computeChipState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/Worktree/utils/computeChipState")>();
  return {
    ...actual,
    computeChipState: (...args: Parameters<typeof actual.computeChipState>) => {
      chipStateCalls.count++;
      chipStateCalls.waitingCounts.push(args[0].waitingTerminalCount);
      return actual.computeChipState(...args);
    },
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { WorktreeOverviewModal } from "../WorktreeOverviewModal";

const WORKTREES = 30;
const AGENTS_PER_WORKTREE = 30;
const UPDATES = 100;
const ROOT = "/repo";

const stats = { commits: 0, ms: 0 };
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  stats.commits++;
  stats.ms += actualDuration;
};

function worktreeId(w: number) {
  return w === 0 ? ROOT : `${ROOT}-wt-${w}`;
}

function panelId(w: number, a: number) {
  return `pane-${w}-${a}`;
}

let worktrees: WorktreeState[];

beforeEach(async () => {
  initBuiltInPanelKinds();
  worktrees = Array.from({ length: WORKTREES }, (_, w) => {
    const id = worktreeId(w);
    return {
      id,
      worktreeId: id,
      path: id,
      name: w === 0 ? "repo" : `wt-${w}`,
      branch: w === 0 ? "develop" : `feature/${w}`,
      isCurrent: w === 0,
      isMainWorktree: w === 0,
      worktreeChanges: null,
      lastActivityTimestamp: 1_000 + w,
    } as WorktreeState;
  });
  const worktreeStore = createWorktreeStore();
  worktreeStore.setState({
    worktrees: new Map(worktrees.map((wt) => [wt.id, wt])),
  });
  setCurrentViewStore(worktreeStore);

  const states = ["working", "waiting", "idle", "completed"] as const;
  const panels: PtyPanelData[] = [];
  for (let w = 0; w < WORKTREES; w++) {
    for (let a = 0; a < AGENTS_PER_WORKTREE; a++) {
      panels.push({
        id: panelId(w, a),
        title: "claude",
        kind: "terminal",
        cwd: worktreeId(w),
        cols: 120,
        rows: 40,
        worktreeId: worktreeId(w),
        location: "grid",
        hasPty: true,
        detectedAgentId: "claude",
        launchAgentId: "claude",
        agentState: states[(w + a) % states.length],
        runtimeStatus: "running",
      } as PtyPanelData);
    }
  }
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const p of panels) (panelIdsByWorktreeId[p.worktreeId!] ??= []).push(p.id);
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId,
  });

  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Profiler id="overview" onRender={onRender}>
          <WorktreeOverviewModal
            isOpen
            onClose={() => {}}
            worktrees={worktrees}
            activeWorktreeId={ROOT}
            onSelectWorktree={() => {}}
          />
        </Profiler>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await settle();
  stats.commits = 0;
  stats.ms = 0;
  chipStateCalls.count = 0;
  chipStateCalls.waitingCounts = [];
});

afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("WorktreeOverviewModal under activity-headline churn", () => {
  it("does not recompute worktree meta for headline writes", async () => {
    const { updateActivity } = usePanelStore.getState();
    const start = performance.now();
    for (let i = 0; i < UPDATES; i++) {
      const w = i % WORKTREES;
      const a = (i * 7) % AGENTS_PER_WORKTREE;
      act(() => {
        updateActivity(panelId(w, a), `headline ${i}`, "working", "interactive", "");
      });
    }
    const wallMs = performance.now() - start;
    await settle();

    const recomputes = chipStateCalls.count / WORKTREES;
    if (process.env.OVERVIEW_ACTIVITY_BENCH) {
      process.stderr.write(
        `[overview-activity-bench] updates=${UPDATES} metaRecomputes=${recomputes} ` +
          `commits=${stats.commits} renderMs=${stats.ms.toFixed(2)} wallMs=${wallMs.toFixed(2)}\n`
      );
    }
    expect(usePanelStore.getState().panelsById[panelId(9, 3)]).toMatchObject({
      activityHeadline: "headline 99",
    });
    expect(recomputes).toBe(0);
  });

  // Proves the counter sees real recomputes, so the zero above is not vacuous.
  it("still recomputes when an agent state changes", async () => {
    act(() => {
      usePanelStore.getState().updateAgentState(panelId(0, 0), "waiting");
    });
    await settle();
    expect(chipStateCalls.count).toBe(WORKTREES);
    // Worktree 0 seeds a waiting agent at every a % 4 === 1; pane 0 joins them.
    const seededWaiting = Array.from({ length: AGENTS_PER_WORKTREE }, (_, a) => a).filter(
      (a) => a % 4 === 1
    ).length;
    expect(chipStateCalls.waitingCounts[0]).toBe(seededWaiting + 1);
    expect(stats.commits).toBeGreaterThan(0);
  });
});
