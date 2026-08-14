// @vitest-environment jsdom
/**
 * The Snooze submenu on an agent terminal (#11783).
 *
 * Covers the two things the component decides that nothing else can: which
 * durations it offers, and whether "Wake now" is present — the latter reads
 * live snooze state off the fleet snapshot, so it is the one place the
 * "presence means snoozed" contract is consumed rather than produced.
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

vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

// Agent terminals only — the snooze submenu rides the same eligibility gate the
// fleet items do, so this must be true for the branch to render at all.
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
import { AGENT_SNOOZE_LABEL } from "@shared/utils/agentSnoozeDurations";

const snoozeRun = vi.fn(() => Promise.resolve({ snoozedAt: 0 }));
const unsnoozeRun = vi.fn(() => Promise.resolve(true));

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
  snapshotState.current = null;
  (window as unknown as { electron: unknown }).electron = { fleet: { snoozeRun, unsnoozeRun } };
});

afterEach(() => {
  cleanup();
  dispatch.mockReset();
  snoozeRun.mockClear();
  unsnoozeRun.mockClear();
});

describe("TerminalContextMenu — Snooze submenu", () => {
  it("offers every duration on the ladder", () => {
    renderMenu();

    for (const label of Object.values(AGENT_SNOOZE_LABEL)) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("names the release condition on the unlimited option", () => {
    // The one option whose behaviour isn't obvious from a bare label — without
    // this it reads as "never".
    renderMenu();

    expect(screen.getByText(/until I interact/i)).toBeTruthy();
  });

  it("sends the picked duration to main rather than a resolved timestamp", () => {
    // Main owns expiry; a renderer-computed wake time would be a second clock.
    renderMenu();
    fireEvent.click(screen.getByText(AGENT_SNOOZE_LABEL["30m"]));

    expect(snoozeRun).toHaveBeenCalledWith("panel-1", "30m");
  });

  it("passes the unlimited option through unresolved", () => {
    renderMenu();
    fireEvent.click(screen.getByText(AGENT_SNOOZE_LABEL.unlimited));

    expect(snoozeRun).toHaveBeenCalledWith("panel-1", "unlimited");
  });

  it("hides Wake now while the run is not snoozed", () => {
    renderMenu();

    expect(screen.queryByText("Wake now")).toBeNull();
  });

  it("offers Wake now once the snapshot carries a snooze for this run", () => {
    // Presence on the row IS "currently snoozed" — main strips expired records
    // before they ship, so the menu never checks a clock.
    snapshotState.current = { runs: [{ runId: "panel-1", snooze: { snoozedAt: 1 } }] };
    renderMenu();

    expect(screen.getByText("Wake now")).toBeTruthy();
  });

  it("does not offer Wake now for a snooze belonging to a different run", () => {
    snapshotState.current = { runs: [{ runId: "panel-2", snooze: { snoozedAt: 1 } }] };
    renderMenu();

    expect(screen.queryByText("Wake now")).toBeNull();
  });

  it("lifts the snooze for this run when Wake now is chosen", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", snooze: { snoozedAt: 1 } }] };
    renderMenu();
    fireEvent.click(screen.getByText("Wake now"));

    expect(unsnoozeRun).toHaveBeenCalledWith("panel-1");
  });
});
