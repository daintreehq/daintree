// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

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

function seed(panels: PtyPanelData[], focusedId: string | null): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: {},
    tabGroups: new Map(),
    trashedTerminals: new Map(),
    focusedId,
  });
}

function run(id: string): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerTerminalLayoutActions(actions, { getActiveWorktreeId: () => "wt-1" } as never);
  return Promise.resolve(actions.get(id)!().run(undefined, {}));
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
});
