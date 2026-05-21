// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TabGroup } from "@shared/types/panel";

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return {
    ...actual,
    cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
  };
});

const { panelState, dispatchMock, applyRendererPolicyMock } = vi.hoisted(() => ({
  panelState: { panelsById: {} as Record<string, unknown> },
  dispatchMock: vi.fn(),
  applyRendererPolicyMock: vi.fn(),
}));

vi.mock("@/store", () => ({
  panelStoreApi: { getState: () => panelState },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { applyRendererPolicy: applyRendererPolicyMock },
}));

// Import after mocks
import { OverflowStatusStrip } from "../OverflowStatusStrip";
import { TerminalRefreshTier } from "@shared/types/panel";

function makeGroup(id: string, panelIds: string[], activeTabId?: string): TabGroup {
  return {
    id,
    panelIds,
    activeTabId: activeTabId ?? panelIds[0] ?? "",
    location: "grid",
    worktreeId: "wt-1",
  };
}

function makePanel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal" as const,
    title: `Panel ${id}`,
    location: "grid",
    worktreeId: "wt-1",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

beforeEach(() => {
  panelState.panelsById = {};
  dispatchMock.mockClear();
  applyRendererPolicyMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OverflowStatusStrip", () => {
  it("renders nothing when groups is empty", () => {
    const { container } = render(<OverflowStatusStrip groups={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one card per overflow group", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1", { title: "Panel one" }),
      "p-2": makePanel("p-2", { title: "Panel two" }),
      "p-3": makePanel("p-3", { title: "Panel three" }),
    };
    const groups: TabGroup[] = [
      makeGroup("g-1", ["p-1"]),
      makeGroup("g-2", ["p-2"]),
      makeGroup("g-3", ["p-3"]),
    ];

    render(<OverflowStatusStrip groups={groups} />);

    const cards = screen.getAllByRole("button");
    expect(cards).toHaveLength(3);
    expect(screen.getByText("Panel one")).toBeTruthy();
    expect(screen.getByText("Panel two")).toBeTruthy();
    expect(screen.getByText("Panel three")).toBeTruthy();
  });

  it("shows the count header with correct pluralization", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1"),
    };

    const { rerender } = render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"])]} />);
    expect(screen.getByText(/1 more agent$/)).toBeTruthy();

    panelState.panelsById = {
      "p-1": makePanel("p-1"),
      "p-2": makePanel("p-2"),
    };
    rerender(
      <OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"]), makeGroup("g-2", ["p-2"])]} />
    );
    expect(screen.getByText(/2 more agents$/)).toBeTruthy();
  });

  it("dispatches terminal.moveToDock with the active panel id on click", () => {
    panelState.panelsById = {
      "p-active": makePanel("p-active", { title: "Active panel" }),
      "p-other": makePanel("p-other"),
    };
    const group = makeGroup("g-tab", ["p-other", "p-active"], "p-active");

    render(<OverflowStatusStrip groups={[group]} />);
    fireEvent.click(screen.getByRole("button"));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.moveToDock",
      { terminalId: "p-active" },
      { source: "user" }
    );
  });

  it("shows the activity headline when present", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1", {
        title: "Claude",
        activityHeadline: "Refactoring grid layout",
      }),
    };

    render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"])]} />);
    expect(screen.getByText("Refactoring grid layout")).toBeTruthy();
  });

  it("falls back to lastCommand when activityHeadline is absent", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1", { lastCommand: "npm run build" }),
    };

    render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"])]} />);
    expect(screen.getByText("npm run build")).toBeTruthy();
  });

  it("shows tab count when a group has multiple panels", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1", { title: "Multi" }),
      "p-2": makePanel("p-2"),
      "p-3": makePanel("p-3"),
    };

    render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1", "p-2", "p-3"])]} />);
    expect(screen.getByText("(3 tabs)")).toBeTruthy();
  });

  it("applies BACKGROUND tier to overflow panels on mount", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1"),
      "p-2": makePanel("p-2"),
    };

    render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"]), makeGroup("g-2", ["p-2"])]} />);

    expect(applyRendererPolicyMock).toHaveBeenCalledWith("p-1", TerminalRefreshTier.BACKGROUND);
    expect(applyRendererPolicyMock).toHaveBeenCalledWith("p-2", TerminalRefreshTier.BACKGROUND);
  });

  it("restores VISIBLE tier on unmount so re-entry into the grid resumes streaming", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1"),
    };

    const { unmount } = render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"])]} />);
    applyRendererPolicyMock.mockClear();
    unmount();

    expect(applyRendererPolicyMock).toHaveBeenCalledWith("p-1", TerminalRefreshTier.VISIBLE);
  });

  it("survives a panel disappearing between renders without throwing", () => {
    panelState.panelsById = {
      "p-1": makePanel("p-1"),
    };

    const { rerender } = render(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"])]} />);

    panelState.panelsById = {};
    expect(() =>
      rerender(<OverflowStatusStrip groups={[makeGroup("g-1", ["p-1"])]} />)
    ).not.toThrow();
  });

  it("drops groups whose panels are all absent from the store so the count matches what renders", () => {
    panelState.panelsById = {
      "p-real": makePanel("p-real"),
    };

    render(
      <OverflowStatusStrip
        groups={[makeGroup("g-real", ["p-real"]), makeGroup("g-ghost", ["p-missing"])]}
      />
    );

    // Header counts renderable groups, not the raw input list.
    expect(screen.getByText(/1 more agent$/)).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders nothing when every group's panels are absent from the store", () => {
    panelState.panelsById = {};
    const { container } = render(
      <OverflowStatusStrip groups={[makeGroup("g-1", ["p-missing"])]} />
    );
    expect(container.firstChild).toBeNull();
  });
});
