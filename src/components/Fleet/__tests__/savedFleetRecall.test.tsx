// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

// Snapshots resolve to their non-"gone" ids; a rule matches two panes unless
// it filters on "finished", which matches none.
function resolveIds(scope: { terminalIds?: string[]; stateFilter?: string }): string[] {
  if (scope.terminalIds) return scope.terminalIds.filter((id) => !id.startsWith("gone"));
  return scope.stateFilter === "finished" ? [] : ["r1", "r2"];
}

vi.mock("@/services/actions/definitions/fleetActions", () => ({
  resolveSavedScopeIds: vi.fn(resolveIds),
  computeSavedScopePaneCount: vi.fn(
    (scope: { terminalIds?: string[] }) => resolveIds(scope).length
  ),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { actionService } from "@/services/ActionService";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { FleetSavedScope } from "@shared/types";
import {
  formatSavedFleetCount,
  savedFleetAccessibleName,
  storedPaneCount,
} from "../savedFleetMeta";
import { SavedFleetQuickRecall } from "../SavedFleetQuickRecall";
import { SaveFleetDialog } from "../SaveFleetDialog";

function snapshot(id: string, terminalIds: string[]): FleetSavedScope {
  return { kind: "snapshot", id, name: id, terminalIds, createdAt: 1 };
}

function setSaved(scopes: FleetSavedScope[]) {
  useProjectSettingsStore.setState({ settings: { runCommands: [], fleetSavedScopes: scopes } });
}

beforeEach(() => {
  vi.mocked(actionService.dispatch).mockReset();
  setSaved([]);
});

describe("saved fleet counts", () => {
  it("a snapshot that lost panes never reads like an intact one of the same size", () => {
    const intact = snapshot("intact", ["a", "b"]);
    const partial = snapshot("partial", ["a", "b", "c", "d"]);
    expect(formatSavedFleetCount(partial, 2)).not.toBe(formatSavedFleetCount(intact, 2));
    expect(savedFleetAccessibleName(partial, 2)).not.toBe(
      savedFleetAccessibleName({ ...intact, name: "partial" }, 2)
    );
  });

  it("an intact snapshot's count is exactly the number it would arm", () => {
    const intact = snapshot("intact", ["a", "b", "b"]);
    expect(storedPaneCount(intact)).toBe(2);
    expect(formatSavedFleetCount(intact, storedPaneCount(intact))).toBe("2");
  });

  it("every accessible name leads with the fleet's own name", () => {
    const scopes: FleetSavedScope[] = [
      snapshot("Bugfix pair", ["a"]),
      {
        kind: "predicate",
        id: "p",
        name: "Everything waiting",
        scope: "all",
        stateFilter: "waiting",
        createdAt: 1,
      },
    ];
    for (const scope of scopes) {
      for (const count of [0, 1, 3]) {
        expect(savedFleetAccessibleName(scope, count).startsWith(`${scope.name},`)).toBe(true);
      }
    }
  });
});

describe("SavedFleetQuickRecall", () => {
  it("offers exactly the fleets that would arm something now", () => {
    setSaved([
      snapshot("live", ["a"]),
      snapshot("dead", ["gone-1"]),
      {
        kind: "predicate",
        id: "rule",
        name: "rule",
        scope: "all",
        stateFilter: "waiting",
        createdAt: 1,
      },
      {
        kind: "predicate",
        id: "empty-rule",
        name: "empty-rule",
        scope: "all",
        stateFilter: "finished",
        createdAt: 1,
      },
    ]);
    render(<SavedFleetQuickRecall mode="replace" onManage={vi.fn()} onRecalled={vi.fn()} />);
    const names = screen
      .getAllByTestId("fleet-picker-saved-fleet")
      .map((b) => b.getAttribute("title"));
    expect(names.sort()).toEqual(["live", "rule"]);
  });

  it("renders nothing when nothing is saved", () => {
    setSaved([]);
    const { container } = render(
      <SavedFleetQuickRecall mode="replace" onManage={vi.fn()} onRecalled={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("still reaches Manage when every saved fleet is stale", () => {
    const onManage = vi.fn();
    setSaved([snapshot("dead", ["gone-1"])]);
    render(<SavedFleetQuickRecall mode="replace" onManage={onManage} onRecalled={vi.fn()} />);
    expect(screen.queryAllByTestId("fleet-picker-saved-fleet")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("fleet-picker-saved-manage"));
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("recalls the clicked fleet and hands control back to the host", () => {
    const onRecalled = vi.fn();
    setSaved([snapshot("live", ["a"])]);
    render(<SavedFleetQuickRecall mode="replace" onManage={vi.fn()} onRecalled={onRecalled} />);
    fireEvent.click(screen.getByTestId("fleet-picker-saved-fleet"));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "fleet.recallNamedFleet",
      { id: "live" },
      { source: "user" }
    );
    expect(onRecalled).toHaveBeenCalledTimes(1);
  });
});

describe("SavedFleetQuickRecall in Append mode", () => {
  it("adds the fleet's panes to the armed set instead of replacing it", async () => {
    const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
    const addToFleet = vi.fn();
    const original = useFleetArmingStore.getState().addToFleet;
    useFleetArmingStore.setState({ addToFleet });
    try {
      const onRecalled = vi.fn();
      setSaved([snapshot("live", ["a", "gone-1", "b"])]);
      render(<SavedFleetQuickRecall mode="append" onManage={vi.fn()} onRecalled={onRecalled} />);
      fireEvent.click(screen.getByTestId("fleet-picker-saved-fleet"));
      expect(addToFleet).toHaveBeenCalledWith(["a", "b"]);
      expect(actionService.dispatch).not.toHaveBeenCalled();
      expect(onRecalled).toHaveBeenCalledTimes(1);
    } finally {
      useFleetArmingStore.setState({ addToFleet: original });
    }
  });
});

describe("SavedFleetQuickRecall in Append mode counts only what it would add", () => {
  it("hides a fleet that is already fully armed and counts the rest by new panes", async () => {
    const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
    useFleetArmingStore.setState({ armedIds: new Set(["a", "b"]) });
    try {
      setSaved([snapshot("covered", ["a", "b"]), snapshot("partly", ["a", "c", "d"])]);
      render(<SavedFleetQuickRecall mode="append" onManage={vi.fn()} onRecalled={vi.fn()} />);
      const chips = screen.getAllByTestId("fleet-picker-saved-fleet");
      expect(chips.map((c) => c.getAttribute("title"))).toEqual(["partly"]);
      expect(chips[0]!.getAttribute("aria-label")).toMatch(/\b2 panes\b/);
    } finally {
      useFleetArmingStore.setState({ armedIds: new Set() });
    }
  });
});

describe("SavedFleetsDialog", () => {
  it("lists every saved fleet, arms only the ones that would arm something, and gates delete on a confirm", async () => {
    const { SavedFleetsDialog } = await import("../SavedFleetsDialog");
    setSaved([snapshot("live", ["a"]), snapshot("dead", ["gone-1"])]);
    const onClose = vi.fn();
    render(<SavedFleetsDialog isOpen onClose={onClose} />);
    expect(screen.getAllByTestId("fleet-saved-manage-row")).toHaveLength(2);
    const arms = screen.getAllByTestId("fleet-saved-manage-arm");
    const disabled = arms.filter(
      (b) => b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true"
    );
    expect(disabled).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Delete fleet "dead"'));
    });
    expect(actionService.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete fleet" }));
    });
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "fleet.deleteNamedFleet",
      { id: "dead" },
      { source: "user" }
    );
  });
});

describe("SaveFleetDialog", () => {
  async function submitNamed(name: string) {
    fireEvent.change(screen.getByTestId("fleet-save-form-name"), { target: { value: name } });
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("fleet-save-form-name"), { key: "Enter" });
    });
  }

  it("closes once the fleet is actually saved", async () => {
    vi.mocked(actionService.dispatch).mockImplementation(async () => {
      setSaved([snapshot("new", ["a"])]);
      return { ok: true, result: undefined };
    });
    const onClose = vi.fn();
    render(<SaveFleetDialog isOpen onClose={onClose} armedCount={2} />);
    await submitNamed("Morning triage");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog and the typed name when the save doesn't land", async () => {
    // The action rolls back and reports on its own; nothing new is stored.
    vi.mocked(actionService.dispatch).mockResolvedValue({ ok: true, result: undefined });
    const onClose = vi.fn();
    render(<SaveFleetDialog isOpen onClose={onClose} armedCount={2} />);
    await submitNamed("Morning triage");
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId("fleet-save-form-name") as HTMLInputElement).value).toBe(
      "Morning triage"
    );
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("does not submit a blank name", async () => {
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={2} />);
    await submitNamed("   ");
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });
});
