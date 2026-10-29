// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@/types";

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

vi.mock("@/components/Terminal/gridLayoutSnapshot", () => ({ getGridLayoutSnapshot: vi.fn() }));
vi.mock("@/components/Panel/animatePanelMove", () => ({ animatePanelMove: vi.fn() }));

const { usePanelStore } = await import("@/store/panelStore");
const { useLayoutUndoStore } = await import("@/store/layoutUndoStore");
const { useLayoutConfigStore } = await import("@/store/layoutConfigStore");
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

beforeEach(() => {
  useLayoutUndoStore.getState().clearHistory();
});

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
      {
        id: "tabs",
        location: "dock",
        worktreeId: "wt-1",
        activeTabId: "t2",
        panelIds: ["t1", "t2"],
      },
    ]);

    await run("terminal.moveRight");

    expect(order("dock")).toEqual(["a", "t1", "t2"]);
    expect(undoDepth()).toBe(1);
  });

  it("moves a single chip past a whole group chip", async () => {
    seed([panel("t1", "dock"), panel("t2", "dock"), panel("a", "dock")], "a", [
      {
        id: "tabs",
        location: "dock",
        worktreeId: "wt-1",
        activeTabId: "t1",
        panelIds: ["t1", "t2"],
      },
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

  it("undoes a dock move back to the previous chip order", async () => {
    seed([panel("a", "dock"), panel("b", "dock")], "b");

    await run("terminal.moveLeft");
    expect(order("dock")).toEqual(["b", "a"]);

    useLayoutUndoStore.getState().undo();

    expect(order("dock")).toEqual(["a", "b"]);
  });
});

describe("terminal.moveLeft / moveRight from a focused dock chip with its preview closed", () => {
  let chip: HTMLButtonElement;

  beforeEach(() => {
    const slot = document.createElement("div");
    slot.dataset.dockItemId = "c";
    chip = document.createElement("button");
    chip.setAttribute("data-dock-item", "");
    chip.scrollIntoView = vi.fn();
    slot.appendChild(chip);
    document.body.appendChild(slot);
    chip.focus();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("moves the focused chip, not the grid panel that owns focusedId", async () => {
    seed([panel("g1", "grid"), panel("g2", "grid"), panel("b", "dock"), panel("c", "dock")], "g2");

    await run("terminal.moveLeft", { dispatchSource: "keybinding" });

    expect(order("dock")).toEqual(["c", "b"]);
    expect(order("grid")).toEqual(["g1", "g2"]);
    expect(document.activeElement).toBe(chip);
  });

  it("ignores DOM focus for a dispatch that didn't come from the keyboard", async () => {
    seed([panel("g1", "grid"), panel("g2", "grid"), panel("b", "dock"), panel("c", "dock")], "g2");

    await run("terminal.moveLeft", { dispatchSource: "agent" });

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
});
