/**
 * Every path that re-files a panel's worktree has to mirror the filing onto the
 * pty-host record: the fleet palette groups runs by that record and nothing
 * else re-stamps it after spawn (#12060).
 *
 * The moves and the trash restores were covered when the sync first landed.
 * These are their siblings — the promotions (dock→grid, drag-to-position,
 * grouped, dialog) and the background restores. Promotion matters most: it is
 * how a run spawned without a worktree usually acquires one, so a promotion
 * that skips the hop leaves the commonest case filed under "No worktree".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelInstance, PtyPanelData, TabGroup } from "@shared/types/panel";
import { setWorktreeSelectionAccessor } from "@/store/storeAccessors";
import { getPanelKindConfig, registerPanelKind } from "@shared/config/panelKindRegistry";
import { buildWorktreeIndex } from "../worktreeIndex";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    updateWorktreeId: vi.fn(),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue(null) },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
    wake: vi.fn(),
    getInstance: vi.fn(),
    setInputLocked: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../../persistence/tabGroupPersistence", () => ({
  tabGroupPersistence: { save: vi.fn(), load: vi.fn().mockReturnValue([]) },
}));

const { usePanelStore } = await import("../../../panelStore");
const { usePanelLimitStore } = await import("../../../panelLimitStore");
const { terminalClient } = await import("@/clients");

const ACTIVE_WORKTREE = "/repo/wt-active";
const OTHER_WORKTREE = "/repo/wt-other";

let warnSpy: ReturnType<typeof vi.spyOn>;

function ptyPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "dock",
    isVisible: false,
    ...overrides,
  };
}

function seed(panels: PanelInstance[], tabGroups?: TabGroup[]): void {
  const panelsById = Object.fromEntries(panels.map((p) => [p.id, p]));
  const panelIds = panels.map((p) => p.id);
  usePanelStore.setState({
    panelsById,
    panelIds,
    panelIdsByWorktreeId: buildWorktreeIndex(panelIds, panelsById),
    tabGroups: new Map((tabGroups ?? []).map((g) => [g.id, g])),
  });
}

function syncCalls(): unknown[][] {
  return vi.mocked(terminalClient.updateWorktreeId).mock.calls;
}

/** What the panel store now holds — the value the host copy must agree with. */
function liveWorktreeId(id: string): string | undefined {
  return usePanelStore.getState().panelsById[id]?.worktreeId;
}

beforeEach(() => {
  vi.clearAllMocks();
  setWorktreeSelectionAccessor(() => ({
    activeWorktreeId: ACTIVE_WORKTREE,
    restoreWorktreeId: null,
  }));
  usePanelLimitStore.setState({ hardLimit: 50 });
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    panelIdsByWorktreeId: {},
    tabGroups: new Map(),
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
    focusedId: null,
    maximizedId: null,
  });
});

afterEach(() => {
  setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
});

describe("moveTerminalToGrid", () => {
  it("files the promoted run on the host record under the worktree it adopted", () => {
    seed([ptyPanel("p1")]);

    usePanelStore.getState().moveTerminalToGrid("p1");

    expect(liveWorktreeId("p1")).toBe(ACTIVE_WORKTREE);
    expect(syncCalls()).toEqual([["p1", liveWorktreeId("p1")]]);
  });

  it("stays silent when the panel already carries its own filing", () => {
    // Promotion never overwrites a real attribution, so there is nothing for
    // the host to learn — a sync here would be pure IPC noise on every drag.
    seed([ptyPanel("p1", { worktreeId: OTHER_WORKTREE })]);

    usePanelStore.getState().moveTerminalToGrid("p1");

    expect(liveWorktreeId("p1")).toBe(OTHER_WORKTREE);
    expect(syncCalls()).toHaveLength(0);
  });

  it("skips a kind with no pty record to update", () => {
    seed([
      {
        id: "f1",
        kind: "file",
        title: "notes",
        location: "dock",
        filePath: "/repo/notes.md",
        fileViewMode: "source",
      } as PanelInstance,
    ]);

    usePanelStore.getState().moveTerminalToGrid("f1");

    expect(liveWorktreeId("f1")).toBe(ACTIVE_WORKTREE);
    expect(syncCalls()).toHaveLength(0);
  });
});

describe("promoteDialogPanelToGrid", () => {
  it("files a promoted dialog run on the host record", () => {
    seed([ptyPanel("d1", { location: "dialog", excludeFromPersistence: true })]);

    expect(usePanelStore.getState().promoteDialogPanelToGrid("d1")).toBe(true);

    expect(liveWorktreeId("d1")).toBe(ACTIVE_WORKTREE);
    expect(syncCalls()).toEqual([["d1", liveWorktreeId("d1")]]);
  });

  it("stays silent when the ceiling refuses the promotion", () => {
    // Nothing moved, so nothing may be re-filed: a sync on a refused promotion
    // would hand the palette a worktree the panel never took.
    usePanelLimitStore.setState({ hardLimit: 1 });
    seed([
      ptyPanel("g1", { location: "grid", worktreeId: OTHER_WORKTREE }),
      ptyPanel("d1", { location: "dialog", excludeFromPersistence: true }),
    ]);

    expect(usePanelStore.getState().promoteDialogPanelToGrid("d1")).toBe(false);
    expect(syncCalls()).toHaveLength(0);
  });
});

describe("moveTerminalToPosition", () => {
  it("files a run dragged out of the dock under the drop target's worktree", () => {
    seed([ptyPanel("p1")]);

    usePanelStore.getState().moveTerminalToPosition("p1", 0, "grid", OTHER_WORKTREE);

    expect(liveWorktreeId("p1")).toBe(OTHER_WORKTREE);
    expect(syncCalls()).toEqual([["p1", liveWorktreeId("p1")]]);
  });

  it("stays silent on a reorder inside the dock", () => {
    seed([ptyPanel("p1"), ptyPanel("p2")]);

    usePanelStore.getState().moveTerminalToPosition("p2", 0, "dock");

    expect(syncCalls()).toHaveLength(0);
  });
});

describe("moveTabGroupToLocation", () => {
  it("files every member of a promoted group, not just the anchor", () => {
    seed(
      [ptyPanel("p1"), ptyPanel("p2")],
      [{ id: "g1", location: "dock", activeTabId: "p1", panelIds: ["p1", "p2"] }]
    );

    expect(usePanelStore.getState().moveTabGroupToLocation("g1", "grid")).toBe(true);

    expect(syncCalls()).toEqual(
      expect.arrayContaining([
        ["p1", liveWorktreeId("p1")],
        ["p2", liveWorktreeId("p2")],
      ])
    );
    expect(syncCalls()).toHaveLength(2);
    expect(liveWorktreeId("p1")).toBe(ACTIVE_WORKTREE);
  });

  it("stays silent when the group already carries its own filing", () => {
    seed(
      [
        ptyPanel("p1", { worktreeId: OTHER_WORKTREE }),
        ptyPanel("p2", { worktreeId: OTHER_WORKTREE }),
      ],
      [
        {
          id: "g1",
          location: "dock",
          worktreeId: OTHER_WORKTREE,
          activeTabId: "p1",
          panelIds: ["p1", "p2"],
        },
      ]
    );

    usePanelStore.getState().moveTabGroupToLocation("g1", "grid");

    expect(syncCalls()).toHaveLength(0);
  });
});

describe("restoreBackgroundTerminal", () => {
  it("files a run restored into another worktree on the host record", () => {
    seed([ptyPanel("p1", { location: "grid", worktreeId: OTHER_WORKTREE })]);
    usePanelStore.setState({
      backgroundedTerminals: new Map([["p1", { id: "p1", originalLocation: "grid" as const }]]),
    });

    usePanelStore.getState().restoreBackgroundTerminal("p1", ACTIVE_WORKTREE);

    expect(liveWorktreeId("p1")).toBe(ACTIVE_WORKTREE);
    expect(syncCalls()).toEqual([["p1", liveWorktreeId("p1")]]);
  });

  it("stays silent when the restore leaves the filing where it was", () => {
    seed([ptyPanel("p1", { location: "grid", worktreeId: OTHER_WORKTREE })]);
    usePanelStore.setState({
      backgroundedTerminals: new Map([["p1", { id: "p1", originalLocation: "grid" as const }]]),
    });

    usePanelStore.getState().restoreBackgroundTerminal("p1");

    expect(liveWorktreeId("p1")).toBe(OTHER_WORKTREE);
    expect(syncCalls()).toHaveLength(0);
  });
});

describe("restoreBackgroundGroup", () => {
  it("files every member restored into another worktree", () => {
    seed([
      ptyPanel("p1", { location: "grid", worktreeId: OTHER_WORKTREE }),
      ptyPanel("p2", { location: "grid", worktreeId: OTHER_WORKTREE }),
    ]);
    usePanelStore.setState({
      backgroundedTerminals: new Map([
        ["p1", { id: "p1", originalLocation: "grid" as const, groupRestoreId: "gr1" }],
        ["p2", { id: "p2", originalLocation: "grid" as const, groupRestoreId: "gr1" }],
      ]),
    });

    usePanelStore.getState().restoreBackgroundGroup("gr1", ACTIVE_WORKTREE);

    expect(syncCalls()).toEqual(
      expect.arrayContaining([
        ["p1", liveWorktreeId("p1")],
        ["p2", liveWorktreeId("p2")],
      ])
    );
    expect(syncCalls()).toHaveLength(2);
    expect(liveWorktreeId("p2")).toBe(ACTIVE_WORKTREE);
  });

  it("stays silent when the group comes back where it left", () => {
    seed([
      ptyPanel("p1", { location: "grid", worktreeId: OTHER_WORKTREE }),
      ptyPanel("p2", { location: "grid", worktreeId: OTHER_WORKTREE }),
    ]);
    usePanelStore.setState({
      backgroundedTerminals: new Map([
        ["p1", { id: "p1", originalLocation: "grid" as const, groupRestoreId: "gr1" }],
        ["p2", { id: "p2", originalLocation: "grid" as const, groupRestoreId: "gr1" }],
      ]),
    });

    usePanelStore.getState().restoreBackgroundGroup("gr1");

    expect(syncCalls()).toHaveLength(0);
  });
});

describe("dock→grid rescue of an undockable pty kind", () => {
  // A restore rescues a pane out of the dock only when its kind stopped being
  // dockable under it (#11375) — and that rescue is what adopts the active
  // worktree. Flipping the terminal kind's own dockability is the shortest way
  // to reach the branch without a panel shape outside the built-in union.
  let originalTerminalKind: ReturnType<typeof getPanelKindConfig>;

  beforeEach(() => {
    originalTerminalKind = getPanelKindConfig("terminal");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerPanelKind({ ...originalTerminalKind!, dockable: false });
  });

  afterEach(() => {
    registerPanelKind(originalTerminalKind!);
    warnSpy.mockRestore();
  });

  function seedRescuable(): void {
    seed([ptyPanel("p1", { location: "dock" })]);
  }

  it("files a background restore that rescued the pane into the grid", () => {
    seedRescuable();
    usePanelStore.setState({
      backgroundedTerminals: new Map([["p1", { id: "p1", originalLocation: "dock" as const }]]),
    });

    usePanelStore.getState().restoreBackgroundTerminal("p1");

    expect(usePanelStore.getState().panelsById["p1"]?.location).toBe("grid");
    expect(liveWorktreeId("p1")).toBe(ACTIVE_WORKTREE);
    expect(syncCalls()).toEqual([["p1", liveWorktreeId("p1")]]);
  });

  it("files the same rescue when it arrives through markAsRestored", () => {
    // The last defensive restore boundary adopts a worktree exactly as the
    // ordinary restore does, so it owes the host record the same hop.
    seedRescuable();
    usePanelStore.setState({
      trashedTerminals: new Map([
        ["p1", { id: "p1", expiresAt: Date.now() + 60_000, originalLocation: "dock" as const }],
      ]),
    });

    usePanelStore.getState().markAsRestored("p1");

    expect(usePanelStore.getState().panelsById["p1"]?.location).toBe("grid");
    expect(liveWorktreeId("p1")).toBe(ACTIVE_WORKTREE);
    expect(syncCalls()).toEqual([["p1", liveWorktreeId("p1")]]);
  });
});
