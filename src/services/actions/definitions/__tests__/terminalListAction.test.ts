import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalClientMock = vi.hoisted(() => ({ submit: vi.fn() }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: panelStoreMock.getState },
}));
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { registerTerminalQueryActions } from "../terminalQueryActions";

type TerminalListItem = {
  id: string;
  isFocused: boolean;
  agentId: string | null;
  location: string;
};

function setupActions() {
  const actions: ActionRegistry = new Map();
  registerTerminalQueryActions(actions, {} as ActionCallbacks);
  return actions;
}

async function callList(actions: ActionRegistry, args?: unknown): Promise<TerminalListItem[]> {
  const factory = actions.get("terminal.list");
  if (!factory) throw new Error("missing terminal.list");
  const def = factory() as AnyActionDefinition;
  return (await def.run(args, {} as never)) as TerminalListItem[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("terminal.list isFocused field", () => {
  it("flags exactly one item when a panel matches focusedId", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "term-b",
      panelIds: ["term-a", "term-b", "term-c"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "agent", location: "grid" },
        "term-c": { id: "term-c", kind: "terminal", location: "dock" },
      },
    });

    const items = await callList(setupActions());
    const focusedIds = items.filter((t) => t.isFocused).map((t) => t.id);
    expect(focusedIds).toEqual(["term-b"]);
  });

  it("returns isFocused:false for every item when focusedId is null", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: null,
      panelIds: ["term-a", "term-b"],
      panelsById: {
        "term-a": { id: "term-a", kind: "terminal", location: "grid" },
        "term-b": { id: "term-b", kind: "terminal", location: "grid" },
      },
    });

    const items = await callList(setupActions());
    expect(items.every((t) => t.isFocused === false)).toBe(true);
  });

  it("flags a focused dock terminal as isFocused:true", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "term-dock",
      panelIds: ["term-grid", "term-dock"],
      panelsById: {
        "term-grid": { id: "term-grid", kind: "terminal", location: "grid" },
        "term-dock": { id: "term-dock", kind: "agent", location: "dock" },
      },
    });

    const items = await callList(setupActions());
    const dock = items.find((t) => t.id === "term-dock");
    expect(dock?.isFocused).toBe(true);
  });
});
