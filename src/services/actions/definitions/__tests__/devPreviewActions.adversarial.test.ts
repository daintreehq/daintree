// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));

import { registerDevPreviewActions } from "../devPreviewActions";

const restartMock = vi.fn(async () => ({}));
const restartAndClearCacheMock = vi.fn(async () => ({}));
const reinstallAndRestartMock = vi.fn(async () => ({}));
const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerDevPreviewActions(actions, callbacks);
  return {
    actions,
    run: async (id: string, args?: unknown, ctx?: Partial<ActionContext>): Promise<unknown> => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      const def = factory() as AnyActionDefinition;
      return def.run(args, (ctx ?? {}) as ActionContext);
    },
    def: (id: string) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      return factory() as AnyActionDefinition;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  panelStoreMock.getState.mockReturnValue({ focusedId: null });
  Object.defineProperty(globalThis.window, "dispatchEvent", {
    value: dispatchSpy,
    configurable: true,
  });
  Object.defineProperty(globalThis.window, "electron", {
    value: {
      devPreview: {
        restart: restartMock,
        restartAndClearCache: restartAndClearCacheMock,
        reinstallAndRestart: reinstallAndRestartMock,
      },
    },
    configurable: true,
  });
});

describe("devPreviewActions adversarial", () => {
  it("reloadPreview dispatches hard-reload to focused panel when no panelId given", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-x" });
    const { run } = setupActions();
    await run("devPreview.reloadPreview");

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { id: string };
    };
    expect(event.type).toBe("daintree:hard-reload-browser");
    expect(event.detail.id).toBe("panel-x");
  });

  it("reloadPreview explicit panelId overrides focusedId", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "focused" });
    const { run } = setupActions();
    await run("devPreview.reloadPreview", { panelId: "explicit" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as { detail: { id: string } };
    expect(event.detail.id).toBe("explicit");
  });

  it("reloadPreview with no target is a silent no-op", async () => {
    const { run } = setupActions();
    await run("devPreview.reloadPreview");
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("restart resolves panelId from focus and projectId from context", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-1" });
    const { run } = setupActions();
    await run("devPreview.restart", undefined, { projectId: "proj-1" });

    expect(restartMock).toHaveBeenCalledWith({ panelId: "panel-1", projectId: "proj-1" });
  });

  it("restart explicit args override focus and context", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "focused" });
    const { run } = setupActions();
    await run("devPreview.restart", { panelId: "p2", projectId: "pr2" }, { projectId: "ctx" });

    expect(restartMock).toHaveBeenCalledWith({ panelId: "p2", projectId: "pr2" });
  });

  it("restart throws when no panel is focused", async () => {
    const { run } = setupActions();
    await expect(run("devPreview.restart", undefined, { projectId: "p" })).rejects.toThrow(
      /No dev preview panel/
    );
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("restart throws when no project is open", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-1" });
    const { run } = setupActions();
    await expect(run("devPreview.restart")).rejects.toThrow(/No project/);
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("restartAndClearCache calls the clear-cache IPC and is danger:confirm", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-1" });
    const { run, def } = setupActions();
    await run("devPreview.restartAndClearCache", undefined, { projectId: "proj-1" });

    expect(restartAndClearCacheMock).toHaveBeenCalledWith({
      panelId: "panel-1",
      projectId: "proj-1",
    });
    expect(def("devPreview.restartAndClearCache").danger).toBe("confirm");
  });

  it("reinstallAndRestart calls the reinstall IPC and is danger:confirm", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-1" });
    const { run, def } = setupActions();
    await run("devPreview.reinstallAndRestart", undefined, { projectId: "proj-1" });

    expect(reinstallAndRestartMock).toHaveBeenCalledWith({
      panelId: "panel-1",
      projectId: "proj-1",
    });
    expect(def("devPreview.reinstallAndRestart").danger).toBe("confirm");
  });

  it("propagates IPC rejection from restartAndClearCache through run()", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-1" });
    restartAndClearCacheMock.mockRejectedValueOnce(new Error("ipc boom"));
    const { run } = setupActions();

    await expect(
      run("devPreview.restartAndClearCache", undefined, { projectId: "proj-1" })
    ).rejects.toThrow(/ipc boom/);
  });

  it("propagates IPC rejection from reinstallAndRestart through run()", async () => {
    panelStoreMock.getState.mockReturnValue({ focusedId: "panel-1" });
    reinstallAndRestartMock.mockRejectedValueOnce(new Error("ipc boom"));
    const { run } = setupActions();

    await expect(
      run("devPreview.reinstallAndRestart", undefined, { projectId: "proj-1" })
    ).rejects.toThrow(/ipc boom/);
  });

  it("reloadPreview and restart are danger:safe", () => {
    const { def } = setupActions();
    expect(def("devPreview.reloadPreview").danger).toBe("safe");
    expect(def("devPreview.restart").danger).toBe("safe");
  });
});
