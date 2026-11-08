/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import type { WorktreeDiskUsage } from "@/hooks/useWorktreeDiskUsage";
import { WorktreeOverviewColumnHeaders, WorktreeOverviewRow } from "../WorktreeOverviewRow";

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

const worktree = {
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
});

function renderRow(diskUsage: WorktreeDiskUsage | undefined) {
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
            diskUsage={diskUsage}
            onActivate={vi.fn()}
            onToggleSelect={vi.fn()}
            onBeforeMenuAction={vi.fn()}
            onFocusLost={vi.fn()}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  return screen.getByRole("gridcell");
}

describe("WorktreeOverviewRow disk usage (#16393)", () => {
  it("marks a measured size as approximate", () => {
    const cell = renderRow({ status: "measured", bytes: 3 * 1024 * 1024 * 1024 });
    expect(cell.textContent).toContain("≈ 3 GB");
    expect(cell.textContent).toContain("About 3 GB on disk");
  });

  it("shows a measured empty worktree as a size, not as unknown", () => {
    const cell = renderRow({ status: "measured", bytes: 0 });
    expect(cell.textContent).toContain("≈ 0 B");
    expect(cell.textContent).not.toContain("Unknown");
  });

  it("shows unknown as unknown, never as zero", () => {
    const cell = renderRow({ status: "unknown" });
    expect(cell.textContent).toContain("Unknown");
    expect(cell.textContent).not.toMatch(/0 B/);
  });

  it("shows a size still being measured as pending, with no figure", () => {
    for (const usage of [{ status: "pending" } as const, undefined]) {
      const cell = renderRow(usage);
      expect(cell.textContent).toContain("Measuring size");
      expect(cell.textContent).not.toMatch(/≈|Unknown/);
      expect(cell.querySelector("[data-skeleton-bone]")).not.toBeNull();
      cleanup();
    }
  });
});

describe("WorktreeOverviewColumnHeaders size ordering", () => {
  it("is a toggle whose label stays put while its pressed state follows the order", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <WorktreeOverviewColumnHeaders sortBySize={false} onSortBySizeChange={onChange} />
    );
    const button = screen.getByRole("button", { name: "Order by size, largest first" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<WorktreeOverviewColumnHeaders sortBySize onSortBySizeChange={onChange} />);
    const pressed = screen.getByRole("button", { name: "Order by size, largest first" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the decorative column labels out of the accessibility tree", () => {
    const { container } = render(
      <WorktreeOverviewColumnHeaders sortBySize={false} onSortBySizeChange={vi.fn()} />
    );
    const labels = Array.from(container.firstElementChild!.children).filter(
      (el) => el.tagName !== "BUTTON"
    );
    expect(labels.map((el) => el.textContent)).toEqual(["Worktree", "Sessions", "Changes", "Active"]);
    for (const label of labels) expect(label.getAttribute("aria-hidden")).toBe("true");
  });
});
