// @vitest-environment jsdom
/**
 * While an agent edits files, its own worktree's snapshot is replaced on every
 * git-status pass (modifiedCount, lastActivityTimestamp, ...). The composer only
 * draws the worktree's label, so that churn must not re-render it — it lands
 * exactly while the user is typing. Mounts the real HybridInputBar and counts
 * Profiler commits. Prints metrics with COMPOSER_WORKTREE_BENCH=1.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import {
  createWorktreeStore,
  setCurrentViewStore,
  type WorktreeViewStoreApi,
} from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";

const UPDATES = 100;
const WT_ID = "/repo/wt-feature";

const stats = { commits: 0, ms: 0 };
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  stats.commits++;
  stats.ms += actualDuration;
};

let worktreeStore: WorktreeViewStoreApi;

function snapshot(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id: WT_ID,
    worktreeId: WT_ID,
    path: WT_ID,
    name: "wt-feature",
    branch: "feature/composer",
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    lastActivityTimestamp: 0,
    ...overrides,
  } as WorktreeSnapshot;
}

function setSnapshot(next: WorktreeSnapshot) {
  worktreeStore.setState((s) => {
    const worktrees = new Map(s.worktrees);
    worktrees.set(WT_ID, next);
    return { worktrees };
  });
}

beforeEach(async () => {
  initBuiltInPanelKinds();
  worktreeStore = createWorktreeStore();
  worktreeStore.setState({ worktrees: new Map([[WT_ID, snapshot()]]) });
  setCurrentViewStore(worktreeStore);
  const panel = {
    id: "term-1",
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "working",
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
  });

  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <Profiler id="composer" onRender={onRender}>
          <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={() => {}} />
        </Profiler>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await settle();
  stats.commits = 0;
  stats.ms = 0;
});

afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("HybridInputBar under its worktree's git-status churn", () => {
  it("does not re-render when only unrelated snapshot fields change", async () => {
    const start = performance.now();
    for (let i = 1; i <= UPDATES; i++) {
      act(() => {
        setSnapshot(snapshot({ modifiedCount: i, lastActivityTimestamp: 1_000 + i }));
      });
    }
    const wallMs = performance.now() - start;
    await settle();

    if (process.env.COMPOSER_WORKTREE_BENCH) {
      process.stderr.write(
        `[composer-worktree-bench] updates=${UPDATES} commits=${stats.commits} ` +
          `renderMs=${stats.ms.toFixed(2)} wallMs=${wallMs.toFixed(2)}\n`
      );
    }
    expect(stats.commits).toBe(0);
  });

  // Proves the Profiler sees real renders, so the zero above is not vacuous.
  it("still re-renders when the drawn branch label changes", async () => {
    act(() => {
      setSnapshot(snapshot({ branch: "feature/renamed" }));
    });
    await settle();
    expect(stats.commits).toBeGreaterThan(0);
  });
});
