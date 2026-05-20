// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";

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
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

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
import type { FleetSavedScope } from "@shared/types";

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

beforeEach(() => {
  useProjectSettingsStore.setState({ settings: {} } as any);
  useFleetArmingStore.setState({ armedIds: new Set() });
  vi.clearAllMocks();
});

describe("SavedFleetsSection", () => {
  it("renders snapshots under Pinned label", () => {
    setSavedScopes([SNAPSHOT_A, SNAPSHOT_B]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Pinned")).toBeDefined();
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
    expect(screen.getByText("Pinned")).toBeDefined();
    expect(screen.getByText("Smart-Sets")).toBeDefined();
    expect(screen.getByText("My terminals")).toBeDefined();
    expect(screen.getByText("Finished here")).toBeDefined();
  });

  it("shows only Pinned when no non-preset predicates exist", () => {
    setSavedScopes([SNAPSHOT_A, PREDICATE_WAITING_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.getByText("Pinned")).toBeDefined();
    expect(screen.queryByText("Smart-Sets")).toBeNull();
  });

  it("shows only Smart-Sets when no snapshots exist", () => {
    setSavedScopes([PREDICATE_FINISHED_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(screen.getByText("Smart-Sets")).toBeDefined();
  });

  it("shows neither section label when no saved scopes exist", () => {
    setSavedScopes([]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    expect(screen.queryByText("Pinned")).toBeNull();
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

  it("renders Pinned group before Smart-Sets group in DOM order", () => {
    setSavedScopes([SNAPSHOT_A, PREDICATE_FINISHED_CURRENT]);
    render(<SavedFleetsSection onRequestDelete={vi.fn()} />);
    const groups = screen.getAllByTestId("dropdown-group");
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain("Pinned");
    expect(groups[0].textContent).toContain("My terminals");
    expect(groups[1].textContent).toContain("Smart-Sets");
    expect(groups[1].textContent).toContain("Finished here");
  });
});
