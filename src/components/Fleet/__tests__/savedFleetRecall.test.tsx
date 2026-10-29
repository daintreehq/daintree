// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render as rtlRender,
  fireEvent,
  screen,
  act,
  type RenderOptions,
} from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

// Snapshots resolve to their non-"gone" ids; a rule matches two panes unless
// it filters on "finished", which matches none.
function resolveIds(scope: { terminalIds?: string[]; stateFilter?: string }): string[] {
  if (scope.terminalIds) return scope.terminalIds.filter((id) => !id.startsWith("gone"));
  return scope.stateFilter === "finished" ? [] : ["r1", "r2"];
}

vi.mock("@/services/actions/definitions/fleetSavedScope", () => ({
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
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import type { FleetSavedScope } from "@shared/types";
import {
  formatSavedFleetCount,
  savedFleetAccessibleName,
  storedPaneCount,
} from "../savedFleetMeta";
import { SavedFleetQuickRecall } from "../SavedFleetQuickRecall";
import { SaveFleetDialog, describeLeftOut } from "../SaveFleetDialog";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

function render(ui: ReactElement, options?: Omit<RenderOptions, "queries">) {
  return rtlRender(ui, { wrapper: TooltipProvider, ...options });
}

function snapshot(id: string, terminalIds: string[]): FleetSavedScope {
  return { kind: "snapshot", id, name: id, terminalIds, createdAt: 1 };
}

function setSaved(scopes: FleetSavedScope[]) {
  useProjectSettingsStore.setState({ settings: { runCommands: [], fleetSavedScopes: scopes } });
}

beforeEach(() => {
  vi.mocked(actionService.dispatch).mockReset();
  setSaved([]);
  useFleetArmingStore.getState().clear();
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

/** The fleet name a chip shows (the leading label span; the trailing one is its count). */
const chipName = (chip: HTMLElement) =>
  chip.querySelector('[data-slot="button-content"] > span')?.textContent ?? null;

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
    const names = screen.getAllByTestId("fleet-picker-saved-fleet").map(chipName);
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
      expect(chips.map(chipName)).toEqual(["partly"]);
      expect(chips[0]!.getAttribute("aria-label")).toMatch(/\b2 panes\b/);
    } finally {
      useFleetArmingStore.setState({ armedIds: new Set() });
    }
  });
});

describe("SavedFleetsDialog", () => {
  it("lists every saved fleet, arms only the ones that would arm something, and deletes without a confirm", async () => {
    const { SavedFleetsDialog } = await import("../SavedFleetsDialog");
    const { useProjectStore } = await import("@/store/projectStore");
    useProjectStore.setState({ currentProject: { id: "p1" } } as never);
    useProjectSettingsStore.setState({ projectId: "p1" });
    setSaved([snapshot("live", ["a"]), snapshot("dead", ["gone-1"])]);
    vi.mocked(actionService.dispatch).mockImplementation(async () => {
      setSaved([snapshot("live", ["a"])]);
      return { ok: true, result: undefined };
    });
    const onClose = vi.fn();
    render(<SavedFleetsDialog isOpen onClose={onClose} />);
    expect(screen.getAllByTestId("fleet-saved-manage-row")).toHaveLength(2);
    const arms = screen.getAllByTestId("fleet-saved-manage-arm");
    const disabled = arms.filter(
      (b) => b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true"
    );
    expect(disabled).toHaveLength(1);

    const deleteDead = screen.getByLabelText('Delete fleet "dead"');
    deleteDead.focus();
    await act(async () => {
      fireEvent.click(deleteDead);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "fleet.deleteNamedFleet",
      { id: "dead" },
      { source: "user" }
    );
    // The button went with its row; focus lands on the row that is left.
    expect(document.activeElement).toBe(screen.getByLabelText('Delete fleet "live"'));
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

  function armRemote(terminalId: string, hostName: string) {
    // Host ids are opaque; only the display name belongs in copy.
    useFleetArmingStore.getState().armCrossHostTarget({
      key: `host-fleet:id-${hostName}:${terminalId}`,
      hostId: `id-${hostName}`,
      hostName,
      terminalId,
      title: `Claude ${terminalId}`,
    });
  }

  /** What the snapshot option tells the person, as the radio group reads it out. */
  function typeHint(): string {
    const group = screen.getByRole("radiogroup", { name: "Fleet type" });
    const id = group.getAttribute("aria-describedby") ?? "";
    return document.getElementById(id)?.textContent ?? "";
  }

  const saveButton = () => screen.getByRole("button", { name: "Save fleet" });

  /** Why Save is unavailable, as the disabled button reads it out. */
  function saveBlockedBy(): string | null {
    const id = saveButton().getAttribute("aria-describedby");
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  }

  it("says only the panes armed here when no agent on another host is armed", () => {
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={2} />);
    expect(typeHint()).toBe("The 2 panes armed now. Panes you close drop out of it.");
  });

  it("names the agent on another host a snapshot leaves out, beside the panes it keeps", () => {
    armRemote("t1", "studio-01");
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={2} />);
    expect(typeHint()).toBe(
      "The 2 panes armed now. Panes you close drop out of it." +
        "Left out, since a snapshot can't hold agents on other hosts: Claude t1 on studio-01."
    );
  });

  it("explains why a fleet of only other hosts' agents has no snapshot to save", async () => {
    armRemote("t1", "studio-01");
    armRemote("t2", "studio-02");
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={0} />);
    expect(typeHint()).toBe(
      "Only panes armed here go in a snapshot. Panes you close drop out of it." +
        "Left out, since a snapshot can't hold agents on other hosts: " +
        "Claude t1 on studio-01 and Claude t2 on studio-02."
    );
    await submitNamed("Remote triage");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(saveBlockedBy()).toBe("Arm panes here to save a snapshot");
    expect(actionService.dispatch).not.toHaveBeenCalled();
  });

  it("with nothing armed anywhere, says what a snapshot holds and leaves no one out", () => {
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={0} />);
    expect(typeHint()).toBe(
      "Only panes armed here go in a snapshot. Panes you close drop out of it."
    );
    expect(saveBlockedBy()).toBe("Arm panes here to save a snapshot");
  });

  it("counts the left-out agents past a few names rather than listing every one", () => {
    const targets = ["a", "b", "c", "d", "e"].map((id) => ({
      key: `host-fleet:h:${id}`,
      hostId: "h",
      hostName: "studio",
      terminalId: id,
      title: id.toUpperCase(),
    }));
    expect(describeLeftOut(targets)).toBe(
      "Left out, since a snapshot can't hold agents on other hosts: " +
        "A on studio, B on studio, C on studio, and 2 others."
    );
    // One more name reads better than "and 1 other".
    expect(describeLeftOut(targets.slice(0, 4))).toBe(
      "Left out, since a snapshot can't hold agents on other hosts: " +
        "A on studio, B on studio, C on studio, and D on studio."
    );
  });

  it("drops the snapshot's left-out note for a live rule, which can save with no pane here", async () => {
    armRemote("t1", "studio-01");
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={0} />);
    fireEvent.click(screen.getByRole("radio", { name: "Live rule" }));
    expect(typeHint()).not.toContain("studio-01");
    await submitNamed("Waiting");
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "fleet.saveNamedFleet",
      expect.objectContaining({ kind: "predicate", name: "Waiting" }),
      { source: "user" }
    );
  });

  it("follows the fleet while open: names a host agent armed after opening, drops one disarmed", () => {
    render(<SaveFleetDialog isOpen onClose={vi.fn()} armedCount={1} />);
    expect(typeHint()).not.toContain("studio-01");
    act(() => armRemote("t1", "studio-01"));
    expect(typeHint()).toContain("Claude t1 on studio-01");
    act(() => useFleetArmingStore.getState().disarmCrossHostTarget("host-fleet:id-studio-01:t1"));
    expect(typeHint()).toBe("The 1 pane armed now. Panes you close drop out of it.");
  });
});
