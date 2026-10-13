// @vitest-environment jsdom
/**
 * Park… and Unpark on an agent terminal's menu (#13236). Both read the fleet
 * snapshot: Park… needs the run on it (main rejects an id it can't see), and
 * Unpark needs a park on the row to lift.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type React from "react";

// Render menu content synchronously — Radix only mounts it behind a real
// right-click into a portal, and the branch choice is what is under test.
vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={() => onSelect?.()}>{children}</button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => null,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

const dispatch = vi.hoisted(() => vi.fn());

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { getTerminal: () => undefined, getSelection: () => "" },
}));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({ useSidebarWorktreeOrder: () => [] }));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

// Fleet eligibility only means "live PTY in a grid location" — it says nothing
// about the terminal being an agent. It gets the fleet items rendered; the
// snooze submenu needs the run on the snapshot as well.
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => true,
}));

const snapshotState = vi.hoisted(() => ({
  current: null as { runs: Array<Record<string, unknown>> } | null,
}));

vi.mock("@/store/fleetSnapshotStore", () => ({
  useFleetSnapshotStore: (selector: (s: { snapshot: unknown }) => unknown) =>
    selector({ snapshot: snapshotState.current }),
}));

const panelsById = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/store", () => ({
  usePanelStore: (
    selector: (s: {
      panelsById: Record<string, unknown>;
      maximizeTarget: null;
      getPanelGroup: () => undefined;
      watchedPanels: Set<string>;
    }) => unknown
  ) =>
    selector({
      panelsById: panelsById.current,
      maximizeTarget: null,
      getPanelGroup: () => undefined,
      watchedPanels: new Set<string>(),
    }),
}));

import { TerminalContextMenu } from "../TerminalContextMenu";

const parkRun = vi.fn(() => Promise.resolve({ parkedAt: 0 }));
const unparkRun = vi.fn(() => Promise.resolve(true));

const agentPanel = {
  id: "panel-1",
  title: "Claude",
  kind: "terminal",
  launchAgentId: "claude",
  worktreeId: "wt-1",
};

function renderMenu() {
  panelsById.current = { "panel-1": agentPanel };
  return render(
    <TerminalContextMenu terminalId="panel-1">
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

beforeEach(() => {
  snapshotState.current = { runs: [{ runId: "panel-1" }] };
  Object.defineProperty(window, "electron", {
    value: { fleet: { parkRun, unparkRun } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  dispatch.mockReset();
  parkRun.mockClear();
  unparkRun.mockClear();
});

describe("TerminalContextMenu — Park and Unpark", () => {
  it("withholds Park… when the fleet has no row for this panel", () => {
    snapshotState.current = { runs: [{ runId: "panel-2" }] };
    renderMenu();

    expect(screen.queryByText("Park…")).toBeNull();
  });

  it("withholds Park… before any snapshot has landed", () => {
    snapshotState.current = null;
    renderMenu();

    expect(screen.queryByText("Park…")).toBeNull();
  });

  it("offers Park… for a run the fleet can see, without parking on the spot", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Park…"));

    // The note and release live in the dialog the item opens.
    expect(parkRun).not.toHaveBeenCalled();
  });

  it("hides Unpark while the run is not parked", () => {
    renderMenu();

    expect(screen.queryByText("Unpark")).toBeNull();
  });

  it("does not offer Unpark for a park belonging to a different run", () => {
    snapshotState.current = {
      runs: [{ runId: "panel-1" }, { runId: "panel-2", park: { parkedAt: 1 } }],
    };
    renderMenu();

    expect(screen.queryByText("Unpark")).toBeNull();
  });

  it("keeps Park… beside Unpark on a parked run, so the park can be edited", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu();

    expect(screen.getByText("Park…")).toBeTruthy();
    expect(screen.getByText("Unpark")).toBeTruthy();
  });

  it("lifts the park for this run directly when Unpark is chosen", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu();
    fireEvent.click(screen.getByText("Unpark"));

    expect(unparkRun).toHaveBeenCalledWith("panel-1");
  });
});
