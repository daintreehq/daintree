// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { WorktreeOverviewRow } from "../WorktreeOverviewRow";

// #17263: session targets meet the 24px floor, drift counts match
// UpstreamSyncBadge, and exception words stay in primary ink.

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

const WT = "/repo-wt-1";

const base = {
  id: WT,
  worktreeId: WT,
  path: WT,
  name: "wt-1",
  branch: "feature/one",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: 1_000,
} as WorktreeState;

beforeEach(() => {
  Reflect.set(window, "electron", {
    plugin: { onWorktreeCardStatusesChanged: vi.fn(() => () => {}) },
  });
  useProjectStore.setState({
    currentProject: { id: "proj-a", name: "App", path: "/repo", emoji: "", lastOpened: 0 },
  });
});

afterEach(() => {
  cleanup();
  usePanelStore.setState({ panelsById: {}, panelIds: [], panelIdsByWorktreeId: {} });
});

function renderRow(worktree: WorktreeState) {
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map([[WT, worktree]]) });
  setCurrentViewStore(store);
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <div role="grid">
          <WorktreeOverviewRow
            worktree={worktree}
            cellId="overview-cell"
            chipState={null}
            isCurrent={false}
            isSelected={false}
            isCursor={false}
            isSelecting={false}
            isLast
            onActivate={vi.fn()}
            onToggleSelect={vi.fn()}
            onBeforeMenuAction={vi.fn()}
            onFocusLost={vi.fn()}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

describe("WorktreeOverviewRow drift counts", () => {
  it("colours only the ahead arrow; the figures and the behind arrow stay neutral", () => {
    renderRow({ ...base, aheadCount: 3, behindCount: 5 });
    const ahead = screen.getByLabelText("3 ahead");
    const behind = screen.getByLabelText("5 behind");
    expect(ahead.textContent).toBe("↑3");
    expect(behind.textContent).toBe("↓5");
    expect(ahead.className).not.toMatch(/text-status/);
    expect(behind.className).not.toMatch(/text-status/);
    expect(ahead.querySelector(".text-status-success")?.textContent).toBe("↑");
    expect(ahead.parentElement!.className).toContain("text-text-secondary");
    expect(behind.querySelector("[class*='text-status']")).toBeNull();
  });
});

describe("WorktreeOverviewRow exception", () => {
  it("keeps the severity hue on the glyph and the words in primary ink", () => {
    renderRow({
      ...base,
      worktreeChanges: {
        changedFileCount: 1,
        changes: [{ path: "a.ts", status: "conflicted" }],
      },
    } as unknown as WorktreeState);
    const label = screen.getByText("1 conflict");
    expect(label.className).toContain("text-text-primary");
    expect(label.className).not.toContain("text-status-error");
    expect(label.querySelector("svg")?.getAttribute("class")).toContain("text-status-error");
  });
});

describe("WorktreeOverviewRow session targets", () => {
  it("draws a session line at least 24px tall with a hover backplate", () => {
    const pane = {
      id: "t1",
      kind: "terminal",
      title: "Claude t1",
      lastObservedTitle: "task t1",
      location: "grid",
      worktreeId: WT,
      cwd: WT,
      cols: 80,
      rows: 24,
      launchAgentId: "claude",
      agentState: "waiting",
    } as PtyPanelData;
    act(() =>
      usePanelStore.setState({
        panelsById: { t1: pane },
        panelIds: ["t1"],
        panelIdsByWorktreeId: { [WT]: ["t1"] },
      })
    );
    renderRow(base);
    const button = screen
      .getAllByRole("button")
      .find((b) => (b.getAttribute("aria-label") ?? "").endsWith("task t1"))!;
    expect(button.className).toContain("min-h-6");
    expect(button.className).not.toContain("h-5");
    expect(button.className).toContain("hover:bg-overlay-soft");
  });
});
