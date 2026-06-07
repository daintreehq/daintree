// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-group">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "aria-disabled": ariaDisabled,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    disabled?: boolean;
    "aria-disabled"?: boolean;
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled ? "true" : undefined}
      aria-disabled={ariaDisabled ? "true" : undefined}
      onClick={(e) => {
        if (disabled) return;
        onSelect?.(e as unknown as Event);
      }}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

// Mock computeSavedScopePaneCount so we control staleness deterministically:
// scopes whose terminalIds array is empty count as 0 → stale; everything
// else counts as terminalIds.length (positive → usable).
vi.mock("@/services/actions/definitions/fleetActions", () => ({
  computeSavedScopePaneCount: vi.fn((scope: { terminalIds?: string[]; stateFilter?: string }) => {
    if (scope.terminalIds) return scope.terminalIds.length;
    return 3;
  }),
}));

import { actionService } from "@/services/ActionService";
import { SavedFleetsSection } from "../SavedFleetsSection";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import type { FleetSavedScope } from "@shared/types";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const SNAPSHOT_A: FleetSavedScope = {
  kind: "snapshot",
  id: "snap-a",
  name: "My terminals",
  terminalIds: ["t1", "t2"],
  createdAt: 1000,
};

const SNAPSHOT_B: FleetSavedScope = {
  kind: "snapshot",
  id: "snap-b",
  name: "Stale snapshot",
  terminalIds: [],
  createdAt: 2000,
};

const PREDICATE_WAITING_CURRENT: FleetSavedScope = {
  kind: "predicate",
  id: "pred-wc",
  name: "Waiting here",
  stateFilter: "waiting",
  scope: "current",
  createdAt: 3000,
};

const PREDICATE_WORKING_ALL: FleetSavedScope = {
  kind: "predicate",
  id: "pred-wa",
  name: "Working all",
  stateFilter: "working",
  scope: "all",
  createdAt: 4000,
};

const PREDICATE_ALL_CURRENT: FleetSavedScope = {
  kind: "predicate",
  id: "pred-ac",
  name: "All current",
  stateFilter: "all",
  scope: "current",
  createdAt: 5000,
};

const PREDICATE_FINISHED_CURRENT: FleetSavedScope = {
  kind: "predicate",
  id: "pred-fc",
  name: "Finished here",
  stateFilter: "finished",
  scope: "current",
  createdAt: 6000,
};

const PREDICATE_ALL_ALL: FleetSavedScope = {
  kind: "predicate",
  id: "pred-aa",
  name: "All everything",
  stateFilter: "all",
  scope: "all",
  createdAt: 7000,
};

function setSavedScopes(scopes: FleetSavedScope[]) {
  useProjectSettingsStore.setState({
    settings: {
      fleetSavedScopes: scopes,
    },
  } as any);
}

function rowNames(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole("menuitem")
    .map((r) => r.querySelector("span")?.textContent ?? "");
}

beforeEach(() => {
  useProjectSettingsStore.setState({ settings: {} } as any);
  useFleetArmingStore.setState({ armedIds: new Set() });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("SavedFleetsSection", () => {
  it("renders snapshots under Snapshots label", () => {
    setSavedScopes([SNAPSHOT_A, SNAPSHOT_B]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Snapshots")).toBeDefined();
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.getByText("My terminals")).toBeDefined();
    expect(screen.getByText("Stale snapshot")).toBeDefined();
  });

  it("renders non-preset predicates under Smart-Sets label", () => {
    setSavedScopes([PREDICATE_FINISHED_CURRENT, PREDICATE_ALL_ALL]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Smart-Sets")).toBeDefined();
    expect(screen.getByText("Finished here")).toBeDefined();
    expect(screen.getByText("All everything")).toBeDefined();
  });

  it("suppresses predicates matching hardcoded presets", () => {
    setSavedScopes([
      PREDICATE_WAITING_CURRENT,
      PREDICATE_WAITING_CURRENT, // same combo as preset
      PREDICATE_WORKING_ALL, // same combo as preset
      PREDICATE_ALL_CURRENT, // same combo as preset (armAll current)
      PREDICATE_FINISHED_CURRENT, // not a preset
    ]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    // Only the non-preset predicate should appear
    expect(screen.getByText("Smart-Sets")).toBeDefined();
    expect(screen.getByText("Finished here")).toBeDefined();
    expect(screen.queryByText("Waiting here")).toBeNull();
    expect(screen.queryByText("Working all")).toBeNull();
    expect(screen.queryByText("All current")).toBeNull();
  });

  it("shows both sections when both kinds exist", () => {
    setSavedScopes([SNAPSHOT_A, PREDICATE_FINISHED_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Snapshots")).toBeDefined();
    expect(screen.getByText("Smart-Sets")).toBeDefined();
    expect(screen.getByText("My terminals")).toBeDefined();
    expect(screen.getByText("Finished here")).toBeDefined();
  });

  it("shows only Snapshots when no non-preset predicates exist", () => {
    setSavedScopes([SNAPSHOT_A, PREDICATE_WAITING_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Snapshots")).toBeDefined();
    expect(screen.queryByText("Smart-Sets")).toBeNull();
  });

  it("shows only Smart-Sets when no snapshots exist", () => {
    setSavedScopes([PREDICATE_FINISHED_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.queryByText("Snapshots")).toBeNull();
    expect(screen.getByText("Smart-Sets")).toBeDefined();
  });

  it("shows neither section label when no saved scopes exist", () => {
    setSavedScopes([]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.queryByText("Snapshots")).toBeNull();
    expect(screen.queryByText("Smart-Sets")).toBeNull();
  });

  it("renders stale snapshot with aria-disabled", () => {
    setSavedScopes([SNAPSHOT_B]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Stale snapshot")).toBeDefined();
    const rows = screen.getAllByRole("menuitem");
    const staleRow = rows.find((r) => r.textContent?.includes("Stale snapshot"));
    expect(staleRow).toBeDefined();
    expect(staleRow!.getAttribute("aria-disabled")).toBe("true");
  });

  it("fires onRequestDelete when delete button clicked", () => {
    const onDelete = vi.fn();
    setSavedScopes([SNAPSHOT_A]);
    render(<SavedFleetsSection onRequestDelete={onDelete} />);
    const deleteBtn = screen.getByLabelText('Delete fleet "My terminals"');
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith("snap-a");
  });

  it("fires onRequestDelete when stale snapshot delete button clicked", () => {
    const onDelete = vi.fn();
    setSavedScopes([SNAPSHOT_B]);
    render(<SavedFleetsSection onRequestDelete={onDelete} />);
    const deleteBtn = screen.getByLabelText('Delete fleet "Stale snapshot"');
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith("snap-b");
  });

  it("dispatches recall when live snapshot row is selected", () => {
    setSavedScopes([SNAPSHOT_A]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const rows = screen.getAllByRole("menuitem");
    const liveRow = rows.find((r) => r.textContent?.includes("My terminals"));
    fireEvent.click(liveRow!);
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "fleet.recallNamedFleet",
      { id: "snap-a" },
      { source: "user" }
    );
  });

  it("does not dispatch recall when stale snapshot row is selected", () => {
    setSavedScopes([SNAPSHOT_B]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const rows = screen.getAllByRole("menuitem");
    const staleRow = rows.find((r) => r.textContent?.includes("Stale snapshot"));
    fireEvent.click(staleRow!);
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });

  it("renders Snapshots group before Smart-Sets group in DOM order", () => {
    setSavedScopes([SNAPSHOT_A, PREDICATE_FINISHED_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const groups = screen.getAllByTestId("dropdown-group");
    expect(groups).toHaveLength(2);
    const [first, second] = groups as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain("Snapshots");
    expect(first.textContent).toContain("My terminals");
    expect(second.textContent).toContain("Smart-Sets");
    expect(second.textContent).toContain("Finished here");
  });
});

describe("SavedFleetsSection ranking", () => {
  it("ranks usable snapshots by frecency desc — most-recent first", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lowFrecency: FleetSavedScope = {
      kind: "snapshot",
      id: "low",
      name: "low",
      terminalIds: ["t1"],
      createdAt: 0,
      usageHistory: [NOW - 14 * DAY],
    };
    const highFrecency: FleetSavedScope = {
      kind: "snapshot",
      id: "high",
      name: "high",
      terminalIds: ["t1"],
      createdAt: 0,
      usageHistory: [NOW, NOW - DAY, NOW - 2 * DAY],
    };
    // Insert in array order (low first, high second) to confirm sorting re-orders
    setSavedScopes([lowFrecency, highFrecency]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const [snapGroup] = screen.getAllByTestId("dropdown-group") as [HTMLElement];
    expect(rowNames(snapGroup)).toEqual(["high", "low"]);
  });

  it("demotes stale snapshots below usable ones and adds a separator", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const usable: FleetSavedScope = {
      kind: "snapshot",
      id: "usable",
      name: "usable",
      terminalIds: ["t1"],
      createdAt: 0,
      usageHistory: [NOW],
    };
    const stale: FleetSavedScope = {
      kind: "snapshot",
      id: "stale",
      name: "stale",
      terminalIds: [], // mock returns 0 → stale
      createdAt: 0,
      usageHistory: [NOW],
    };
    // Insert stale first to prove usable wins regardless of array order
    setSavedScopes([stale, usable]);
    const { container } = render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const [snapGroup] = screen.getAllByTestId("dropdown-group") as [HTMLElement];
    expect(rowNames(snapGroup)).toEqual(["usable", "stale"]);
    // Separator sits between the two rows
    const seps = container.querySelectorAll('[data-testid="dropdown-separator"]');
    expect(seps.length).toBeGreaterThan(0);
  });

  it("places a freshly-saved (no usageHistory) snapshot at the bottom of usable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const recalled: FleetSavedScope = {
      kind: "snapshot",
      id: "recalled",
      name: "recalled",
      terminalIds: ["t1"],
      createdAt: 0,
      usageHistory: [NOW],
    };
    const fresh: FleetSavedScope = {
      kind: "snapshot",
      id: "fresh",
      name: "fresh",
      terminalIds: ["t1"],
      createdAt: NOW, // brand-new, never recalled
    };
    setSavedScopes([fresh, recalled]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const [snapGroup] = screen.getAllByTestId("dropdown-group") as [HTMLElement];
    expect(rowNames(snapGroup)).toEqual(["recalled", "fresh"]);
  });

  it("ranks predicate smart-sets by frecency desc", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const low: FleetSavedScope = {
      kind: "predicate",
      id: "p-low",
      name: "low",
      scope: "current",
      stateFilter: "finished",
      createdAt: 0,
      usageHistory: [NOW - 14 * DAY],
    };
    const high: FleetSavedScope = {
      kind: "predicate",
      id: "p-high",
      name: "high",
      scope: "current",
      stateFilter: "finished",
      createdAt: 0,
      usageHistory: [NOW, NOW - DAY],
    };
    setSavedScopes([low, high]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    // The second group is the smart-sets group (predicates)
    const groups = screen.getAllByTestId("dropdown-group");
    const smartSetGroup = groups[groups.length - 1] as HTMLElement;
    expect(rowNames(smartSetGroup)).toEqual(["high", "low"]);
  });

  it("does not render a stale sub-group separator when no usable snapshots exist", () => {
    setSavedScopes([SNAPSHOT_B]); // empty terminalIds → stale
    const { container } = render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const [snapGroup] = screen.getAllByTestId("dropdown-group") as [HTMLElement];
    expect(rowNames(snapGroup)).toEqual(["Stale snapshot"]);
    // No internal separator inside the snapshot group when only stale rows exist
    const groupSeps = snapGroup.querySelectorAll('[data-testid="dropdown-separator"]');
    expect(groupSeps).toHaveLength(0);
    // The leading outer separator (before the group) is rendered exactly once
    const allSeps = container.querySelectorAll('[data-testid="dropdown-separator"]');
    expect(allSeps).toHaveLength(1);
  });
});

describe("SavedFleetsSection integration (real computeSavedScopePaneCount)", () => {
  // Import the mocked module so we can swap the implementation in this
  // describe block. The default mock returns `terminalIds.length`; we
  // replace it with a function that reads live panel-store state so the
  // test exercises the actual panel-eligibility check.
  beforeEach(async () => {
    const mod = (await import("@/services/actions/definitions/fleetActions")) as unknown as {
      computeSavedScopePaneCount: ReturnType<typeof vi.fn>;
    };
    mod.computeSavedScopePaneCount.mockImplementation((scope: { terminalIds?: string[] }) => {
      if (!scope.terminalIds) return 3;
      const { panelsById } = usePanelStore.getState();
      let n = 0;
      for (const id of scope.terminalIds) {
        const panel = panelsById[id];
        if (panel && panel.kind === "terminal" && panel.hasPty !== false) n += 1;
      }
      return n;
    });
  });

  it("demotes a snapshot whose terminalIds are all gone to the stale sub-group", () => {
    setSavedScopes([
      {
        kind: "snapshot",
        id: "gone",
        name: "Gone",
        terminalIds: ["missing-1", "missing-2"],
        createdAt: 0,
      },
    ]);
    // Empty panel store — all terminalIds are missing.
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const [snapGroup] = screen.getAllByTestId("dropdown-group") as [HTMLElement];
    expect(rowNames(snapGroup)).toEqual(["Gone"]);
    const staleRow = within(snapGroup).getByRole("menuitem");
    expect(staleRow.getAttribute("aria-disabled")).toBe("true");
  });

  it("promotes a snapshot back to usable when its terminalIds become eligible", () => {
    setSavedScopes([
      {
        kind: "snapshot",
        id: "fresh",
        name: "fresh",
        terminalIds: ["t-real"],
        createdAt: 0,
      },
    ]);
    usePanelStore.setState({
      panelsById: {
        "t-real": { id: "t-real", kind: "terminal", hasPty: true } as never,
      },
      panelIds: ["t-real"],
    });
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const [snapGroup] = screen.getAllByTestId("dropdown-group") as [HTMLElement];
    expect(rowNames(snapGroup)).toEqual(["fresh"]);
    const liveRow = within(snapGroup).getByRole("menuitem");
    expect(liveRow.getAttribute("aria-disabled")).toBeNull();
  });
});
