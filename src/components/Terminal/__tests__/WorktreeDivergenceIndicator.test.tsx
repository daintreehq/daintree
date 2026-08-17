// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PtyPanelData, PanelWorktreeMoveOptOut } from "@shared/types/panel";

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

const worktrees = new Map<string, unknown>();
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees }),
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("@/store/panelStore");
const { WorktreeDivergenceIndicator } = await import("../WorktreeDivergenceIndicator");

/** The pill lives in the pane header, which sits under the app's TooltipProvider. */
function renderIndicator() {
  return render(
    <TooltipProvider>
      <WorktreeDivergenceIndicator panelId="t1" />
    </TooltipProvider>
  );
}

const MAIN = "/repo";
const FEATURE = "/repo/.worktrees/feature";

const CONSENT: PanelWorktreeMoveOptOut = {
  acknowledgedCwd: MAIN,
  acknowledgedWorktreeId: "wt-feature",
  acknowledgedAlignment: "launch-root-mismatch",
  launchCwd: MAIN,
  launchWorktreeId: "wt-main",
  sourceHeadOid: "aaa",
  at: 1,
};

function seedPanel(overrides: Partial<PtyPanelData> = {}): void {
  const panel: PtyPanelData = {
    id: "t1",
    title: "Codex",
    kind: "terminal",
    cwd: MAIN,
    cols: 80,
    rows: 24,
    worktreeId: "wt-feature",
    location: "grid",
    isVisible: true,
    worktreeMoveOptOut: CONSENT,
    ...overrides,
  };
  usePanelStore.setState({ panelsById: { t1: panel }, panelIds: ["t1"] });
}

function setWorktrees(headOid: string | undefined = "aaa"): void {
  worktrees.clear();
  worktrees.set("wt-main", {
    id: "wt-main",
    path: MAIN,
    name: "main",
    worktreeChanges: headOid ? { headOid } : undefined,
  });
  worktrees.set("wt-feature", { id: "wt-feature", path: FEATURE, name: "feature" });
}

beforeEach(() => {
  cleanup();
  setWorktrees();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("WorktreeDivergenceIndicator", () => {
  it("marks a panel whose process runs outside the worktree it is filed under", () => {
    seedPanel();
    renderIndicator();

    const pill = screen.getByTestId("worktree-divergence-indicator");
    expect(pill.textContent).toContain("main");
    expect(pill.getAttribute("data-head-drifted")).toBeNull();
  });

  it("shows nothing without recorded consent", () => {
    seedPanel({ worktreeMoveOptOut: undefined });
    renderIndicator();

    expect(screen.queryByTestId("worktree-divergence-indicator")).toBeNull();
  });

  it("survives the unmount a worktree switch causes", () => {
    // The pane is dropped from the grid entirely when the user navigates to
    // another worktree (#11589). The marker has to come back on return, which is
    // why the record lives in the panel store rather than in this component.
    seedPanel();
    const first = renderIndicator();
    expect(screen.getByTestId("worktree-divergence-indicator")).toBeTruthy();

    first.unmount();
    expect(screen.queryByTestId("worktree-divergence-indicator")).toBeNull();

    renderIndicator();
    expect(screen.getByTestId("worktree-divergence-indicator")).toBeTruthy();
  });

  it("keeps the marker when the launch root belongs to no current worktree", () => {
    // Deleting the launch worktree does not stop the process committing there,
    // so the marker stays — but it stops claiming to know where "there" is.
    seedPanel();
    worktrees.delete("wt-main");
    renderIndicator();

    expect(screen.getByTestId("worktree-divergence-indicator").textContent).toContain(
      "Location unknown"
    );
  });

  it("clears once a restart re-anchors the process to the worktree it is filed under", () => {
    seedPanel({ cwd: FEATURE });
    renderIndicator();

    expect(screen.queryByTestId("worktree-divergence-indicator")).toBeNull();
  });

  it("escalates when the launch root picks up commits after the move", () => {
    seedPanel();
    setWorktrees("bbb");
    renderIndicator();

    expect(
      screen.getByTestId("worktree-divergence-indicator").getAttribute("data-head-drifted")
    ).toBe("true");
  });

  it("does not claim drift while the launch root's HEAD is still unread", () => {
    seedPanel();
    setWorktrees(undefined);
    renderIndicator();

    expect(
      screen.getByTestId("worktree-divergence-indicator").getAttribute("data-head-drifted")
    ).toBeNull();
  });
});
