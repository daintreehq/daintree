// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShallow } from "zustand/react/shallow";
import type { ActionContext } from "@shared/types/actions";
import type { PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";

const helpPanel = vi.hoisted(() => ({ slotTerminalIds: [] as string[] }));

vi.mock("@/clients", () => ({
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  terminalClient: {},
  projectClient: { getCurrent: vi.fn().mockResolvedValue(null) },
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    flush: vi.fn(),
  },
}));

vi.mock("@/store/helpPanelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/helpPanelStore")>()),
  selectSlotTerminalIds: () => helpPanel.slotTerminalIds,
}));

vi.mock("@/components/Terminal/gridLayoutSnapshot", () => ({ getGridLayoutSnapshot: vi.fn() }));
vi.mock("@/components/Panel/animatePanelMove", () => ({ animatePanelMove: vi.fn() }));

const { usePanelStore } = await import("@/store/panelStore");
const { useLayoutUndoStore } = await import("@/store/layoutUndoStore");
const { useLayoutConfigStore } = await import("@/store/layoutConfigStore");
const { beginSpawnBatch, resetBatchState } =
  await import("@/store/slices/panelRegistry/hydrationBatch");
const { registerTerminalLayoutActions } = await import("../terminalLayoutActions");

type ActionRegistry = Parameters<typeof registerTerminalLayoutActions>[0];

function panel(
  id: string,
  location: "dock" | "grid",
  overrides: Partial<PtyPanelData> = {}
): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    worktreeId: "wt-1",
    location,
    isVisible: location === "grid",
    hasPty: true,
    ...overrides,
  } as PtyPanelData;
}

function seed(panels: PtyPanelData[], focusedId: string | null, groups: TabGroup[] = []): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: {},
    tabGroups: new Map(groups.map((g) => [g.id, g])),
    trashedTerminals: new Map(),
    focusedId,
  });
}

/** `activeWorktreeId: null` runs with no active worktree. */
function run(
  id: string,
  ctx: ActionContext = {},
  activeWorktreeId: string | null = "wt-1"
): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerTerminalLayoutActions(actions, {
    getActiveWorktreeId: () => activeWorktreeId ?? undefined,
  } as never);
  return Promise.resolve(actions.get(id)!().run(undefined, ctx));
}

const order = (location: "dock" | "grid") => {
  const { panelIds, panelsById } = usePanelStore.getState();
  return panelIds.filter((id) => panelsById[id]?.location === location);
};
const undoDepth = () => useLayoutUndoStore.getState().undoStack.length;

const redoDepth = () => useLayoutUndoStore.getState().redoStack.length;

beforeEach(() => {
  useLayoutUndoStore.getState().clearHistory();
  helpPanel.slotTerminalIds = [];
});

function tabGroup(id: string, panelIds: string[], activeTabId = panelIds[0]!): TabGroup {
  return { id, location: "dock", worktreeId: "wt-1", activeTabId, panelIds };
}

describe("terminal.moveLeft / moveRight on a docked panel (#14972)", () => {
  it("moves the focused dock chip one place left", async () => {
    seed([panel("g1", "grid"), panel("a", "dock"), panel("b", "dock"), panel("c", "dock")], "b");

    await run("terminal.moveLeft");

    expect(order("dock")).toEqual(["b", "a", "c"]);
    expect(order("grid")).toEqual(["g1"]);
    expect(undoDepth()).toBe(1);
  });

  it("moves the focused dock chip one place right", async () => {
    seed([panel("a", "dock"), panel("b", "dock"), panel("c", "dock")], "b");

    await run("terminal.moveRight");

    expect(order("dock")).toEqual(["a", "c", "b"]);
    expect(undoDepth()).toBe(1);
  });

  it("leaves the dock alone and pushes no undo entry at either end", async () => {
    seed([panel("a", "dock"), panel("b", "dock")], "a");
    await run("terminal.moveLeft");
    expect(order("dock")).toEqual(["a", "b"]);

    usePanelStore.setState({ focusedId: "b" });
    await run("terminal.moveRight");
    expect(order("dock")).toEqual(["a", "b"]);
    expect(undoDepth()).toBe(0);
  });

  it("moves a group chip past a single chip as one unit", async () => {
    seed([panel("t1", "dock"), panel("t2", "dock"), panel("a", "dock")], "t2", [
      tabGroup("tabs", ["t1", "t2"], "t2"),
    ]);

    await run("terminal.moveRight");

    expect(order("dock")).toEqual(["a", "t1", "t2"]);
    expect(undoDepth()).toBe(1);
  });

  it("moves a single chip past a whole group chip", async () => {
    seed([panel("t1", "dock"), panel("t2", "dock"), panel("a", "dock")], "a", [
      tabGroup("tabs", ["t1", "t2"]),
    ]);

    await run("terminal.moveLeft");

    expect(order("dock")).toEqual(["a", "t1", "t2"]);
  });

  it("counts a global panel in the worktree's dock and skips another worktree's chip", async () => {
    seed(
      [
        panel("a", "dock"),
        panel("elsewhere", "dock", { worktreeId: "wt-2" }),
        panel("global", "dock", { worktreeId: undefined }),
      ],
      "global"
    );

    await run("terminal.moveLeft");

    expect(order("dock")).toEqual(["global", "elsewhere", "a"]);
  });

  it("steps past an assistant terminal parked in the dock and never moves it", async () => {
    helpPanel.slotTerminalIds = ["assistant"];
    seed([panel("a", "dock"), panel("assistant", "dock"), panel("b", "dock")], "b");

    await run("terminal.moveLeft");

    expect(order("dock")).toEqual(["b", "assistant", "a"]);
    expect(undoDepth()).toBe(1);

    usePanelStore.setState({ focusedId: "assistant" });
    await run("terminal.moveRight");

    expect(order("dock")).toEqual(["b", "assistant", "a"]);
    expect(undoDepth()).toBe(1);
  });

  it("leaves a docked panel from another worktree where it is", async () => {
    seed(
      [panel("a", "dock"), panel("elsewhere", "dock", { worktreeId: "wt-2" }), panel("b", "dock")],
      "elsewhere"
    );

    await run("terminal.moveLeft");

    expect(order("dock")).toEqual(["a", "elsewhere", "b"]);
    expect(undoDepth()).toBe(0);
  });

  it("swaps two group chips, undoes and redoes the swap, and keeps redo on an end press", async () => {
    seed(
      [panel("a1", "dock"), panel("a2", "dock"), panel("b1", "dock"), panel("b2", "dock")],
      "a2",
      [tabGroup("first", ["a1", "a2"], "a2"), tabGroup("second", ["b1", "b2"])]
    );

    await run("terminal.moveRight");
    expect(order("dock")).toEqual(["b1", "b2", "a1", "a2"]);
    expect(usePanelStore.getState().tabGroups.get("first")).toMatchObject({
      panelIds: ["a1", "a2"],
      activeTabId: "a2",
    });

    await run("terminal.moveRight");
    expect(order("dock")).toEqual(["b1", "b2", "a1", "a2"]);
    expect(undoDepth()).toBe(1);

    useLayoutUndoStore.getState().undo();
    expect(order("dock")).toEqual(["a1", "a2", "b1", "b2"]);

    usePanelStore.setState({ focusedId: "a2" });
    await run("terminal.moveLeft");
    expect(redoDepth()).toBe(1);

    useLayoutUndoStore.getState().redo();
    expect(order("dock")).toEqual(["b1", "b2", "a1", "a2"]);
  });

  it("refuses to move while a spawn batch holds panels back from panelIds", async () => {
    seed([panel("a", "dock"), panel("b", "dock")], "b");
    beginSpawnBatch();
    try {
      await run("terminal.moveLeft");
    } finally {
      resetBatchState();
    }

    expect(order("dock")).toEqual(["a", "b"]);
    expect(undoDepth()).toBe(0);
  });
});

describe("terminal.moveLeft / moveRight from a focused dock chip with its preview closed", () => {
  /** A keyed chip list, so React reorders it with insertBefore as the rail does. */
  function Rail() {
    const ids = usePanelStore(
      useShallow((s) => s.panelIds.filter((id) => s.panelsById[id]?.location === "dock"))
    );
    return (
      <div>
        {ids.map((id) => (
          <div key={id} data-dock-item-id={id}>
            <button type="button" data-dock-item="" data-testid={`chip-${id}`}>
              {id}
            </button>
          </div>
        ))}
      </div>
    );
  }

  afterEach(cleanup);

  // Either chip of an adjacent swap can be the node React moves, so both
  // directions are covered. A moved node loses focus mid-commit and ReactDOM
  // hands it back after the commit, which holds only while the chip keeps its
  // DOM identity across the reorder.
  it.each([
    ["b", "terminal.moveRight", "g1"],
    ["c", "terminal.moveLeft", null],
  ] as const)(
    "moves focused chip %s with %s instead of focusedId %s, and keeps focus on it",
    async (chipId, actionId, focusedId) => {
      seed([panel("g1", "grid"), panel("b", "dock"), panel("c", "dock")], focusedId);
      render(<Rail />);
      const chip = screen.getByTestId(`chip-${chipId}`);
      chip.focus();

      await act(() => run(actionId, { dispatchSource: "keybinding" }));

      expect(order("dock")).toEqual(["c", "b"]);
      expect(order("grid")).toEqual(["g1"]);
      expect(document.activeElement).toBe(chip);
    }
  );

  it("ignores DOM focus for a dispatch that didn't come from the keyboard", async () => {
    seed([panel("g1", "grid"), panel("g2", "grid"), panel("b", "dock"), panel("c", "dock")], "g2");
    render(<Rail />);
    screen.getByTestId("chip-c").focus();

    await act(() => run("terminal.moveLeft", { dispatchSource: "agent" }));

    expect(order("dock")).toEqual(["b", "c"]);
    expect(order("grid")).toEqual(["g2", "g1"]);
  });
});

describe("terminal.moveLeft / moveRight on a grid panel", () => {
  it("moves the focused grid panel and pushes one undo entry", async () => {
    seed([panel("g1", "grid"), panel("g2", "grid"), panel("d", "dock")], "g1");

    await run("terminal.moveRight");

    expect(order("grid")).toEqual(["g2", "g1"]);
    expect(order("dock")).toEqual(["d"]);
    expect(undoDepth()).toBe(1);
  });

  it("pushes no undo entry at either end of the grid", async () => {
    seed([panel("g1", "grid"), panel("g2", "grid")], "g1");
    await run("terminal.moveLeft");

    usePanelStore.setState({ focusedId: "g2" });
    await run("terminal.moveRight");

    expect(order("grid")).toEqual(["g1", "g2"]);
    expect(undoDepth()).toBe(0);
  });

  it("reorders only worktree-less grid panels when no worktree is active", async () => {
    seed(
      [
        panel("wt-panel", "grid"),
        panel("n1", "grid", { worktreeId: undefined }),
        panel("n2", "grid", { worktreeId: undefined }),
      ],
      "n1"
    );

    await run("terminal.moveRight", {}, null);

    expect(order("grid")).toEqual(["wt-panel", "n2", "n1"]);
  });
});

describe("terminal.moveUp / moveDown", () => {
  it("pushes no undo entry for a docked panel or a move off the grid's edge", async () => {
    useLayoutConfigStore.setState({ layoutConfig: { strategy: "fixed-columns", value: 2 } });
    seed([panel("g1", "grid"), panel("g2", "grid"), panel("d", "dock")], "g1");
    await run("terminal.moveUp");
    await run("terminal.moveDown");

    usePanelStore.setState({ focusedId: "d" });
    await run("terminal.moveUp");
    await run("terminal.moveDown");

    expect(order("grid")).toEqual(["g1", "g2"]);
    expect(undoDepth()).toBe(0);
  });

  it("moves a row at a time within the worktree-less grid, one undo entry per move", async () => {
    useLayoutConfigStore.setState({ layoutConfig: { strategy: "fixed-columns", value: 2 } });
    const loose = { worktreeId: undefined };
    seed(
      [
        panel("foreign", "grid"),
        panel("g1", "grid", loose),
        panel("g2", "grid", loose),
        panel("g3", "grid", loose),
        panel("g4", "grid", loose),
      ],
      "g1"
    );

    await run("terminal.moveDown", {}, null);
    expect(order("grid")).toEqual(["foreign", "g2", "g3", "g1", "g4"]);
    expect(undoDepth()).toBe(1);

    await run("terminal.moveUp", {}, null);
    expect(order("grid")).toEqual(["foreign", "g1", "g2", "g3", "g4"]);
    expect(undoDepth()).toBe(2);
  });
});
