import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const appClientMock = vi.hoisted(() => ({ setState: vi.fn() }));

vi.mock("@/clients", () => ({ appClient: appClientMock, terminalClient: {} }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));
vi.mock("@/store/layoutUndoStore", () => ({ useLayoutUndoStore: { getState: vi.fn() } }));
vi.mock("@/components/Terminal/gridLayoutSnapshot", () => ({ getGridLayoutSnapshot: vi.fn() }));
vi.mock("@/components/Panel/animatePanelMove", () => ({ animatePanelMove: vi.fn() }));

import { registerTerminalLayoutActions } from "../terminalLayoutActions";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";

function run(id: string, args: unknown): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerTerminalLayoutActions(actions, {} as ActionCallbacks);
  const def = actions.get(id)!();
  return Promise.resolve(def.run(args, {}));
}

function deferred() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

const grid = () => useLayoutConfigStore.getState().layoutConfig;

beforeEach(() => {
  vi.clearAllMocks();
  useLayoutConfigStore.setState({ layoutConfig: { strategy: "automatic", value: 3 } });
});

describe("grid layout actions when the save fails (#14700)", () => {
  it("puts back only the strategy, keeping a count changed meanwhile", async () => {
    const save = deferred();
    appClientMock.setState.mockReturnValueOnce(save.promise);
    const pending = run("panel.gridLayout.setStrategy", { strategy: "fixed-rows" });

    useLayoutConfigStore.getState().setLayoutConfig({ strategy: "fixed-rows", value: 7 });
    save.reject(new Error("link down"));

    await expect(pending).rejects.toThrow("link down");
    expect(grid()).toEqual({ strategy: "automatic", value: 7 });
  });

  it("puts back only the count, keeping a strategy changed meanwhile", async () => {
    const save = deferred();
    appClientMock.setState.mockReturnValueOnce(save.promise);
    const pending = run("panel.gridLayout.setValue", { value: 5 });

    useLayoutConfigStore.getState().setLayoutConfig({ strategy: "fixed-columns", value: 5 });
    save.reject(new Error("link down"));

    await expect(pending).rejects.toThrow("link down");
    expect(grid()).toEqual({ strategy: "fixed-columns", value: 3 });
  });

  it("leaves a field alone that a newer change has already moved on", async () => {
    const save = deferred();
    appClientMock.setState.mockReturnValueOnce(save.promise);
    const pending = run("panel.gridLayout.setValue", { value: 5 });

    useLayoutConfigStore.getState().setLayoutConfig({ strategy: "automatic", value: 8 });
    save.reject(new Error("link down"));

    await expect(pending).rejects.toThrow("link down");
    expect(grid()).toEqual({ strategy: "automatic", value: 8 });
  });

  it("leaves the strategy alone when a newer change has already moved it on", async () => {
    const save = deferred();
    appClientMock.setState.mockReturnValueOnce(save.promise);
    const pending = run("panel.gridLayout.setStrategy", { strategy: "fixed-rows" });

    useLayoutConfigStore.getState().setLayoutConfig({ strategy: "fixed-columns", value: 3 });
    save.reject(new Error("link down"));

    await expect(pending).rejects.toThrow("link down");
    expect(grid()).toEqual({ strategy: "fixed-columns", value: 3 });
  });
});
