// @vitest-environment jsdom
/**
 * TerminalContextMenu with the menu primitives rendered inline, so each test reads
 * which branch the component chose rather than what Radix mounted behind a real
 * right-click. Covers a backgrounded or off-worktree panel, "Open in file browser"
 * on a hovered path (#11483), and the fleet's Park/Unpark (#13236) and Snooze
 * (#11783) items.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type React from "react";

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

const {
  dispatch,
  hoveredFilePath,
  hoveredFileKind,
  reportFileLinkFailure,
  worktreeList,
  fleetEligible,
  snapshotState,
  panelsById,
  selectWorktree,
  trackTerminalFocus,
  restoreBackgroundTerminal,
  activateTerminal,
  pingTerminal,
} = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  hoveredFilePath: { current: null as string | null },
  hoveredFileKind: { current: "file" as "file" | "directory" | null },
  reportFileLinkFailure: vi.fn(),
  // `name`/`branch` are carried because the "Move to worktree" submenu labels
  // every entry from them and throws on a bare {id, path}.
  worktreeList: {
    current: [] as Array<{ id: string; path: string; name: string; branch?: string }>,
  },
  fleetEligible: { current: false },
  snapshotState: {
    current: null as { runs: Array<Record<string, unknown>>; degraded?: boolean } | null,
  },
  panelsById: { current: {} as Record<string, unknown> },
  selectWorktree: vi.fn(),
  trackTerminalFocus: vi.fn(),
  restoreBackgroundTerminal: vi.fn(),
  activateTerminal: vi.fn(),
  pingTerminal: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    // A live xterm is what unlocks the hovered-path branch; without it
    // `handleContextMenu` bails and clears every hover field.
    get: () => ({ terminal: { getSelection: () => "" } }),
    getTerminal: () => undefined,
    getSelection: () => "",
    getHoveredLinkText: () => null,
    getHoveredFilePath: () => hoveredFilePath.current,
    getHoveredFileKind: () => (hoveredFilePath.current ? hoveredFileKind.current : null),
    openHoveredLink: vi.fn(),
  },
}));

vi.mock("@/services/terminal/FileLinksAddon", () => ({ reportFileLinkFailure }));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => worktreeList.current,
}));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

// Fleet eligibility only means "live PTY in a grid location" — it says nothing
// about the terminal being an agent. It gets the fleet items rendered; Park and
// Snooze need the run on the snapshot as well.
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => fleetEligible.current,
}));

vi.mock("@/store/fleetSnapshotStore", () => ({
  useFleetSnapshotStore: (selector: (s: { snapshot: unknown }) => unknown) =>
    selector({ snapshot: snapshotState.current }),
}));

vi.mock("@/store/worktreeStore", () => {
  const state = () => ({ activeWorktreeId: "wt-1", selectWorktree, trackTerminalFocus });
  const useWorktreeSelectionStore = (selector: (s: ReturnType<typeof state>) => unknown) =>
    selector(state());
  useWorktreeSelectionStore.getState = state;
  return { useWorktreeSelectionStore };
});

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
    restoreBackgroundTerminal,
    activateTerminal,
    pingTerminal,
  });
  // `getState` too, not just the hook: `handleContextMenu` reads the store
  // imperatively to resolve recent dictation targets.
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { TerminalContextMenu } from "../TerminalContextMenu";
import { AGENT_SNOOZE_LABEL } from "@shared/utils/agentSnoozeDurations";

const agentPanel = {
  id: "panel-1",
  title: "Claude",
  kind: "terminal",
  launchAgentId: "claude",
  worktreeId: "wt-1",
};

function renderMenu(panel: { id: string } & Record<string, unknown> = agentPanel) {
  panelsById.current = { [panel.id]: panel };
  return render(
    <TerminalContextMenu terminalId={panel.id}>
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

beforeEach(() => {
  fleetEligible.current = false;
  snapshotState.current = null;
});

afterEach(() => {
  cleanup();
  dispatch.mockReset();
  worktreeList.current = [];
});

/**
 * The panel menu opened from a row that stands for a pane the user cannot see:
 * a backgrounded panel (the dock's Background popover) or a pane in another
 * worktree (the dock's Waiting popover). Every item must still act on that
 * panel correctly from there.
 */
const terminal = {
  id: "panel-1",
  title: "npm run storybook",
  kind: "terminal",
  worktreeId: "wt-1",
  hasPty: true,
};

describe("TerminalContextMenu — a backgrounded panel", () => {
  beforeEach(() => {
    worktreeList.current = [
      { id: "wt-1", name: "one", path: "/one", branch: "one" },
      { id: "wt-2", name: "two", path: "/two", branch: "two" },
    ];
  });

  afterEach(() => {
    restoreBackgroundTerminal.mockReset();
    activateTerminal.mockReset();
    pingTerminal.mockReset();
    selectWorktree.mockReset();
    trackTerminalFocus.mockReset();
  });

  it("offers its way back instead of moves that would strand its background bookkeeping", () => {
    renderMenu({ ...terminal, location: "background" });

    expect(screen.queryByText("Send to background")).toBeNull();
    expect(screen.queryByText("Move to grid")).toBeNull();
    expect(screen.queryByText("Move to dock")).toBeNull();
    expect(screen.queryByText("Move to worktree")).toBeNull();

    fireEvent.click(screen.getByText("Restore from background"));
    expect(restoreBackgroundTerminal).toHaveBeenCalledWith("panel-1");
    expect(dispatch).not.toHaveBeenCalledWith(
      "terminal.moveToGrid",
      expect.anything(),
      expect.anything()
    );
  });

  it("restores like the row's own Restore: to the pane's worktree, focused", () => {
    renderMenu({ ...terminal, location: "background", worktreeId: "wt-2" });
    fireEvent.click(screen.getByText("Restore from background"));
    expect(selectWorktree).toHaveBeenCalledWith("wt-2");
    expect(trackTerminalFocus).toHaveBeenCalledWith("wt-2", "panel-1");
    expect(restoreBackgroundTerminal).toHaveBeenCalledWith("panel-1");
    expect(activateTerminal).toHaveBeenCalledWith("panel-1");
  });

  it("keeps the ordinary layout items for a panel that is not backgrounded", () => {
    renderMenu({ ...terminal, location: "grid" });
    expect(screen.queryByText("Restore from background")).toBeNull();
    expect(screen.getByText("Send to background")).toBeTruthy();
    expect(screen.getByText("Move to dock")).toBeTruthy();
  });
});

describe("TerminalContextMenu — a pane in another worktree", () => {
  beforeEach(() => {
    worktreeList.current = [
      { id: "wt-1", name: "one", path: "/one", branch: "one" },
      { id: "wt-2", name: "two", path: "/two", branch: "two" },
    ];
  });

  it("does not offer to maximize a pane the grid in front of the user is not showing", () => {
    renderMenu({ ...terminal, location: "grid", worktreeId: "wt-2" });
    expect(screen.queryByText("Maximize")).toBeNull();
  });

  it("offers maximize for the same pane in the active worktree", () => {
    renderMenu({ ...terminal, location: "grid", worktreeId: "wt-1" });
    expect(screen.getByText("Maximize")).toBeTruthy();
  });
});

/**
 * "Open in file browser" on a hovered terminal file path (#11483).
 *
 * Left-clicking a directory link already opened the file browser, but the
 * right-click menu only offered the OS file manager. The contract under test is
 * the argument translation: the menu holds an *absolute* path while
 * `worktree.openFileBrowser` wants a worktree id plus a worktree-*relative*
 * path, and the worktree has to come from the live list rather than the
 * panel's stamped `worktreeId` (#11276).
 */
const LABEL = "Open in file browser";

function worktree(id: string, path: string) {
  return { id, path, name: id, branch: id };
}

function openMenu(options: {
  hovered: string | null;
  kind?: "file" | "directory";
  worktrees?: Array<{ id: string; path: string; name: string }>;
  panelWorktreeId?: string;
}) {
  hoveredFilePath.current = options.hovered;
  hoveredFileKind.current = options.kind ?? "file";
  worktreeList.current = options.worktrees ?? [];
  panelsById.current = {
    "panel-1": {
      id: "panel-1",
      title: "Agent",
      kind: "terminal",
      worktreeId: options.panelWorktreeId ?? "wt-1",
      cwd: "/repo",
    },
  };
  const result = render(
    <TerminalContextMenu terminalId="panel-1">
      <div>Panel body</div>
    </TerminalContextMenu>
  );
  // Populates the hover fields the way a real right-click does.
  act(() => {
    result.container
      .querySelector('[data-context-trigger="panel-1"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  return result;
}

describe("TerminalContextMenu — open in file browser (#11483)", () => {
  afterEach(() => {
    reportFileLinkFailure.mockReset();
    hoveredFilePath.current = null;
    hoveredFileKind.current = "file";
  });

  it("dispatches the containing worktree with a relative path and a file reveal kind", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({ hovered: "/repo/src/index.ts", worktrees: [worktree("wt-1", "/repo")] });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-1", revealPath: "src/index.ts", revealKind: "file" },
      { source: "user" }
    );
  });

  // The panel's stamped worktreeId names whichever worktree was active when the
  // terminal was created, which need not be the one the path lives in (#11276).
  it("resolves against the live worktree list, not the panel's stamped id", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({
      hovered: "/repo/src/index.ts",
      worktrees: [worktree("wt-stamped", "/other"), worktree("wt-real", "/repo")],
      panelWorktreeId: "wt-stamped",
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      expect.objectContaining({ worktreeId: "wt-real" }),
      { source: "user" }
    );
  });

  it("opens the deepest worktree when one is nested inside another", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({
      hovered: "/repo/nested/src/a.ts",
      worktrees: [worktree("wt-outer", "/repo"), worktree("wt-inner", "/repo/nested")],
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-inner", revealPath: "src/a.ts", revealKind: "file" },
      { source: "user" }
    );
  });

  // The file browser is worktree-scoped, so an uncontained path has nothing to
  // open — the item is hidden rather than dispatching a silent no-op.
  it("hides the item for a path in no known worktree, keeping the OS reveal", () => {
    openMenu({ hovered: "/elsewhere/a.ts", worktrees: [worktree("wt-1", "/repo")] });

    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.queryByText(/Reveal in Finder|Show in Explorer|Show in folder/)).toBeTruthy();
  });

  // A sibling root that merely extends the worktree name is not inside it; a
  // raw startsWith would open /repo at the mangled path "-other/src/a.ts".
  it("hides the item for a sibling directory sharing the root prefix", () => {
    openMenu({ hovered: "/repo-other/src/a.ts", worktrees: [worktree("wt-1", "/repo")] });

    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it("offers nothing when no path is hovered", () => {
    openMenu({ hovered: null, worktrees: [worktree("wt-1", "/repo")] });

    expect(screen.queryByText(LABEL)).toBeNull();
  });

  // The worktree root itself resolves to an empty relative path, which must be
  // dropped rather than sent as "" — the action treats "" as "reveal nothing".
  it("omits revealPath when the hovered path is the worktree root", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({ hovered: "/repo", worktrees: [worktree("wt-1", "/repo")] });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-1", revealPath: undefined, revealKind: "file" },
      { source: "user" }
    );
  });

  // dispatch() resolves an ActionDispatchResult and never rejects, so a failure
  // vanishes entirely unless the result is inspected.
  it("reports a failed dispatch through the file-link failure channel", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "gone", details: "worktree removed" },
    });
    openMenu({ hovered: "/repo/src/index.ts", worktrees: [worktree("wt-1", "/repo")] });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    // The reason string is diagnostic copy; what matters is that the failure
    // reached the channel carrying the real details and the offending path.
    expect(reportFileLinkFailure).toHaveBeenCalledWith(
      expect.any(String),
      "worktree removed",
      "/repo/src/index.ts",
      "file"
    );
  });

  // The failure copy is subject-aware, so a folder that fails to open must not
  // be reported as a file the way the default argument would have it.
  it("reports a failed directory dispatch as a folder", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "gone", details: "worktree removed" },
    });
    openMenu({
      hovered: "/repo/src/components",
      kind: "directory",
      worktrees: [worktree("wt-1", "/repo")],
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(reportFileLinkFailure).toHaveBeenCalledWith(
      expect.any(String),
      "worktree removed",
      "/repo/src/components",
      "folder"
    );
  });

  // A directory is expanded as well as selected, so the hovered link's kind has
  // to survive the trip — guessing "file" leaves a right-clicked folder
  // collapsed while left-clicking the very same link opens it.
  it("passes a directory reveal kind through for a hovered directory link", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({
      hovered: "/repo/src/components",
      kind: "directory",
      worktrees: [worktree("wt-1", "/repo")],
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-1", revealPath: "src/components", revealKind: "directory" },
      { source: "user" }
    );
  });
});

/**
 * Park… and Unpark on an agent terminal's menu (#13236). Both read the fleet
 * snapshot: Park… needs the run on it (main rejects an id it can't see), and
 * Unpark needs a park on the row to lift.
 */
const parkRun = vi.fn(() => Promise.resolve({ parkedAt: 0 }));
const unparkRun = vi.fn(() => Promise.resolve(true));

describe("TerminalContextMenu — Park and Unpark", () => {
  beforeEach(() => {
    fleetEligible.current = true;
    snapshotState.current = { runs: [{ runId: "panel-1" }] };
    Object.defineProperty(window, "electron", {
      value: { fleet: { parkRun, unparkRun } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    parkRun.mockClear();
    unparkRun.mockClear();
  });

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
  it("withholds Park… over a degraded snapshot but keeps Unpark", () => {
    // Main rejects a park against retained data; an unpark needs no current view.
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }], degraded: true };
    renderMenu();

    expect(screen.queryByText("Park…")).toBeNull();
    expect(screen.getByText("Unpark")).toBeTruthy();
  });

  it("offers parking on an agent the fleet can't broadcast to (docked, exited)", () => {
    fleetEligible.current = false;
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu();

    expect(screen.getByText("Park…")).toBeTruthy();
    expect(screen.getByText("Unpark")).toBeTruthy();
    expect(screen.queryByText("Snooze")).toBeNull();
  });
});

/**
 * Covers the three things the component decides that nothing else can: whether
 * the submenu is offered at all, which durations it lists, and whether "Wake
 * now" is present. The first and last both read the fleet snapshot, so this is
 * the one place the "presence on the snapshot" contract is consumed rather than
 * produced — for membership (main rejects an id it can't see) and for snooze
 * state (main strips expired records before they ship).
 */
const snoozeRun = vi.fn(() => Promise.resolve({ snoozedAt: 0 }));
const unsnoozeRun = vi.fn(() => Promise.resolve(true));

describe("TerminalContextMenu — Snooze submenu (#11783)", () => {
  beforeEach(() => {
    fleetEligible.current = true;
    // The fleet can see this run, which is what makes it snoozable at all.
    snapshotState.current = { runs: [{ runId: "panel-1" }] };
    Object.defineProperty(window, "electron", {
      value: { fleet: { snoozeRun, unsnoozeRun } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    snoozeRun.mockClear();
    unsnoozeRun.mockClear();
  });

  it("withholds the submenu when the fleet has no row for this panel", () => {
    // Fleet eligibility is satisfied (a plain shell terminal clears it), but
    // main rejects a snooze for an id the snapshot cannot see and the rejection
    // never reaches the user — so the offer must not be made in the first place.
    snapshotState.current = { runs: [{ runId: "panel-2" }] };
    renderMenu();

    expect(screen.queryByText("Snooze")).toBeNull();
    for (const label of Object.values(AGENT_SNOOZE_LABEL)) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("withholds the submenu before any snapshot has landed", () => {
    // Null is "nothing reported yet", not "fleet is empty" — either way there
    // is no row to validate against, so the menu waits.
    snapshotState.current = null;
    renderMenu();

    expect(screen.queryByText("Snooze")).toBeNull();
  });

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
    snapshotState.current = {
      runs: [{ runId: "panel-1" }, { runId: "panel-2", snooze: { snoozedAt: 1 } }],
    };
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
