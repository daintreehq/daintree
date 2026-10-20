import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalClientMock = vi.hoisted(() => ({ locate: vi.fn() }));
const viewWorkspaceIdMock = vi.hoisted(() => ({ getViewWorkspaceId: vi.fn() }));
const pushLayoutSnapshot = vi.hoisted(() => vi.fn());

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock, appClient: {} }));
vi.mock("@/store/viewWorkspaceId", () => viewWorkspaceIdMock);
vi.mock("@/store/layoutUndoStore", () => ({
  useLayoutUndoStore: { getState: () => ({ pushLayoutSnapshot }) },
}));
vi.mock("@/components/Panel/animatePanelMove", () => ({
  animatePanelMove: (_id: string, _direction: string, move: () => unknown) => move(),
}));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {},
}));
vi.mock("@/lib/watchNotification", () => ({ fireWatchNotification: vi.fn() }));
vi.mock("@/store/layoutConfigStore", () => ({ useLayoutConfigStore: { getState: vi.fn() } }));
vi.mock("@/components/Terminal/gridLayoutSnapshot", () => ({ getGridLayoutSnapshot: vi.fn() }));
vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  requestPanelClose: vi.fn(),
  flushOptimisticCloses: vi.fn(),
}));
vi.mock("@/store/terminalPendingDestructiveActionStore", () => ({
  useTerminalPendingDestructiveActionStore: { getState: vi.fn() },
}));

import { registerTerminalLayoutActions } from "../terminalLayoutActions";
import { registerTerminalLifecycleActions } from "../terminalLifecycleActions";
import { TerminalInOtherProjectError } from "@shared/utils/terminalInOtherProject";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";

type Location = "grid" | "dock" | "trash" | "background" | "overlay" | "dialog";
type FakePanel = { id: string; location?: Location; kind?: string };

function setStore(options: {
  panels: FakePanel[];
  focusedId?: string | null;
  groups?: { location: "grid" | "dock"; panelIds: string[] }[];
  /** A mover that leaves the panel where it was. */
  inertMoves?: boolean;
}) {
  let panelsById: Record<string, FakePanel> = {};
  for (const p of options.panels) panelsById[p.id] = { ...p };
  const groups = options.groups ?? [];
  // Like the real lookup, a group only counts while the panel is where the
  // group lives.
  const getPanelGroup = (id: string) => {
    const location = panelsById[id]?.location ?? "grid";
    return groups.find((g) => g.panelIds.includes(id) && g.location === location);
  };
  // Commits replace the record map, as the store does, so an action reading the
  // pre-move snapshot instead of committed state sees the old location.
  const place = (id: string, location: Location) => {
    if (options.inertMoves) return;
    const next = { ...panelsById };
    for (const member of getPanelGroup(id)?.panelIds ?? [id]) {
      const panel = next[member];
      if (panel) next[member] = { ...panel, location };
    }
    panelsById = next;
  };
  const store = {
    backgroundTerminal: vi.fn((id: string) => place(id, "background")),
    backgroundPanelGroup: vi.fn((id: string) => place(id, "background")),
    moveTerminalToDock: vi.fn((id: string) => place(id, "dock")),
    moveTerminalToGrid: vi.fn((id: string) => {
      place(id, "grid");
      return !options.inertMoves;
    }),
    openDockTerminal: vi.fn(),
  };
  panelStoreMock.getState.mockImplementation(() => ({
    focusedId: options.focusedId ?? null,
    panelIds: Object.keys(panelsById),
    panelsById,
    getPanelGroup,
    ...store,
  }));
  return {
    ...store,
    location: (id: string) => panelsById[id]?.location,
  };
}

function setupActions() {
  const actions: ActionRegistry = new Map();
  registerTerminalLifecycleActions(actions, {} as ActionCallbacks);
  registerTerminalLayoutActions(actions, {} as ActionCallbacks);
  return (id: string, args?: unknown, ctx?: unknown): Promise<unknown> => {
    const def = actions.get(id)!() as AnyActionDefinition;
    // ActionService rejects a result that breaks the action's own schema, so
    // every answer these tests accept has to satisfy the published contract.
    if (!def.resultSchema || def.mcpOutputSchema !== true) {
      throw new Error(`${id} no longer publishes its placement result`);
    }
    const schema = def.resultSchema;
    return Promise.resolve(def.run(args, (ctx ?? {}) as never)).then((result) =>
      schema.parse(result)
    );
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => new Error("expected the action to reject"),
    (err: unknown) => err
  );
  if (!(outcome instanceof Error)) throw new Error("rejected with a non-Error");
  return outcome;
}

const ACTIONS = ["terminal.background", "terminal.moveToDock", "terminal.moveToGrid"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  terminalClientMock.locate.mockResolvedValue({ found: false });
  viewWorkspaceIdMock.getViewWorkspaceId.mockReturnValue("proj-a");
});

describe("placement actions on a panel this view does not hold (#13663)", () => {
  it.each(ACTIONS)("%s fails a named miss instead of answering ok", async (id) => {
    const spies = setStore({ panels: [{ id: "p1", location: "grid" }], focusedId: "p1" });

    const err = await rejection(setupActions()(id, { terminalId: "t1" }));

    expect(err).not.toBeInstanceOf(TerminalInOtherProjectError);
    expect(err.message).toBe(
      `${id}: no panel with id "t1" — pass an \`id\` from the terminal listing.`
    );
    expect(spies.backgroundTerminal).not.toHaveBeenCalled();
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
    expect(spies.moveTerminalToGrid).not.toHaveBeenCalled();
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
    expect(spies.location("p1")).toBe("grid");
  });

  it.each(ACTIONS)("%s names the project a terminal is running in", async (id) => {
    setStore({ panels: [] });
    terminalClientMock.locate.mockResolvedValue({
      found: true,
      projectId: "proj-b",
      viewResident: false,
    });

    const err = await rejection(setupActions()(id, { terminalId: "t1" }));

    if (!(err instanceof TerminalInOtherProjectError)) throw err;
    expect(err.toDetails()).toEqual({
      actionId: id,
      terminalId: "t1",
      projectId: "proj-b",
      viewResident: false,
    });
  });

  it.each(ACTIONS)("%s treats a prototype key as a miss, not a panel", async (id) => {
    setStore({ panels: [] });

    await expect(setupActions()(id, { terminalId: "constructor" })).rejects.toThrow(
      /no panel with id "constructor"/
    );
  });

  it.each(ACTIONS)("%s never looks up a panel this view holds", async (id) => {
    setStore({ panels: [{ id: "p1", location: id === "terminal.moveToGrid" ? "dock" : "grid" }] });

    await setupActions()(id, { terminalId: "p1" });

    expect(terminalClientMock.locate).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)("%s stays quiet when nothing is named or focused", async (id) => {
    setStore({ panels: [{ id: "p1", location: "grid" }], focusedId: "gone" });

    await expect(setupActions()(id, {})).resolves.toEqual({ location: null });
    expect(terminalClientMock.locate).not.toHaveBeenCalled();
  });
});

describe("placement results and refusals (#13663)", () => {
  it.each([
    ["terminal.background", "grid", "background"],
    ["terminal.background", "dock", "background"],
    ["terminal.moveToDock", "grid", "dock"],
    ["terminal.moveToGrid", "dock", "grid"],
  ] as const)("%s from %s returns the location it landed in", async (id, from, to) => {
    const spies = setStore({ panels: [{ id: "p1", location: from }] });

    await expect(setupActions()(id, { terminalId: "p1" })).resolves.toEqual({ location: to });
    expect(spies.location("p1")).toBe(to);
  });

  it("opens the dock on the panel it docked", async () => {
    const spies = setStore({ panels: [{ id: "p1", location: "grid" }] });

    await setupActions()("terminal.moveToDock", { terminalId: "p1" });

    expect(spies.openDockTerminal).toHaveBeenCalledWith("p1");
    expect(pushLayoutSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["terminal.background", "background"],
    ["terminal.moveToDock", "dock"],
    ["terminal.moveToGrid", "grid"],
  ] as const)("%s acknowledges a panel already there without moving it", async (id, location) => {
    const spies = setStore({ panels: [{ id: "p1", location }] });

    await expect(setupActions()(id, { terminalId: "p1" })).resolves.toEqual({ location });
    expect(spies.backgroundTerminal).not.toHaveBeenCalled();
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
    expect(spies.moveTerminalToGrid).not.toHaveBeenCalled();
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["terminal.background", "trash"],
    ["terminal.background", "overlay"],
    ["terminal.background", "dialog"],
    ["terminal.moveToDock", "trash"],
    ["terminal.moveToDock", "background"],
    ["terminal.moveToDock", "overlay"],
    ["terminal.moveToDock", "dialog"],
    ["terminal.moveToGrid", "trash"],
    ["terminal.moveToGrid", "background"],
    ["terminal.moveToGrid", "overlay"],
    ["terminal.moveToGrid", "dialog"],
  ] as const)("%s refuses a panel in the %s, leaving no undo entry", async (id, location) => {
    const spies = setStore({ panels: [{ id: "p1", location }], focusedId: "p1" });

    const err = await rejection(setupActions()(id, { terminalId: "p1" }));

    expect(err).toBeInstanceOf(UnactionableTargetError);
    expect(spies.location("p1")).toBe(location);
    expect(spies.backgroundTerminal).not.toHaveBeenCalled();
    expect(spies.moveTerminalToGrid).not.toHaveBeenCalled();
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
  });

  it("refuses to dock a kind the dock cannot show", async () => {
    const spies = setStore({ panels: [{ id: "p1", location: "grid", kind: "diff" }] });

    const err = await rejection(setupActions()("terminal.moveToDock", { terminalId: "p1" }));

    expect(err).toBeInstanceOf(UnactionableTargetError);
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
  });

  it("refuses to dock a group with a member the dock cannot show, rather than landing it in the grid", async () => {
    const spies = setStore({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid", kind: "diff" },
      ],
      groups: [{ location: "grid", panelIds: ["p1", "p2"] }],
    });

    const err = await rejection(setupActions()("terminal.moveToDock", { terminalId: "p1" }));

    expect(err).toBeInstanceOf(UnactionableTargetError);
    expect(err.message).toMatch(/grouped with "p2"/);
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
  });

  it("backgrounds a grouped panel with its group", async () => {
    const spies = setStore({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      groups: [{ location: "grid", panelIds: ["p1", "p2"] }],
    });

    await expect(setupActions()("terminal.background", { terminalId: "p1" })).resolves.toEqual({
      location: "background",
    });
    expect(spies.backgroundPanelGroup).toHaveBeenCalledWith("p1");
    expect(spies.backgroundTerminal).not.toHaveBeenCalled();
  });

  it.each(ACTIONS)("%s fails a move that left the panel where it was", async (id) => {
    setStore({
      panels: [{ id: "p1", location: id === "terminal.moveToGrid" ? "dock" : "grid" }],
      inertMoves: true,
    });

    await expect(setupActions()(id, { terminalId: "p1" })).rejects.toThrow(/did not move to the/);
  });

  it.each([
    ["terminal.background", "grid", "background", "backgroundTerminal"],
    ["terminal.moveToDock", "grid", "dock", "moveTerminalToDock"],
    ["terminal.moveToGrid", "dock", "grid", "moveTerminalToGrid"],
  ] as const)("%s acts on the focused panel when none is named", async (id, from, to, mover) => {
    const spies = setStore({
      panels: [
        { id: "p1", location: from },
        { id: "other", location: from },
      ],
      focusedId: "p1",
    });

    await expect(setupActions()(id, {})).resolves.toEqual({ location: to });
    expect(spies[mover]).toHaveBeenCalledWith("p1");
    expect(spies[mover]).toHaveBeenCalledTimes(1);
    expect(spies.location("p1")).toBe(to);
    expect(spies.location("other")).toBe(from);
  });

  it.each(ACTIONS)("%s refuses a focused panel in the trash", async (id) => {
    setStore({ panels: [{ id: "p1", location: "trash" }], focusedId: "p1" });

    await expect(setupActions()(id, {})).rejects.toBeInstanceOf(UnactionableTargetError);
  });

  it.each(ACTIONS)("%s fails an empty id instead of falling back to focus", async (id) => {
    const spies = setStore({ panels: [{ id: "p1", location: "grid" }], focusedId: "p1" });

    await expect(setupActions()(id, { terminalId: "" })).rejects.toThrow(/no panel with id ""/);
    expect(spies.location("p1")).toBe("grid");
  });

  it("reopens the dock on a panel already docked, without moving it", async () => {
    const spies = setStore({ panels: [{ id: "p1", location: "dock" }] });

    await setupActions()("terminal.moveToDock", { terminalId: "p1" });

    expect(spies.openDockTerminal).toHaveBeenCalledWith("p1");
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
  });

  it.each([
    ["terminal.moveToDock", "dock"],
    ["terminal.moveToGrid", "grid"],
  ] as const)("%s leaves a group already there untouched", async (id, location) => {
    const spies = setStore({
      panels: [
        { id: "p1", location },
        { id: "p2", location },
      ],
      groups: [{ location, panelIds: ["p1", "p2"] }],
    });

    await expect(setupActions()(id, { terminalId: "p1" })).resolves.toEqual({ location });
    expect(spies.moveTerminalToDock).not.toHaveBeenCalled();
    expect(spies.moveTerminalToGrid).not.toHaveBeenCalled();
    expect(pushLayoutSnapshot).not.toHaveBeenCalled();
  });

  it("moves a grouped panel's whole group to the dock", async () => {
    const spies = setStore({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      groups: [{ location: "grid", panelIds: ["p1", "p2"] }],
    });

    await expect(setupActions()("terminal.moveToDock", { terminalId: "p1" })).resolves.toEqual({
      location: "dock",
    });
    expect(spies.location("p2")).toBe("dock");
  });
});
