// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));

const portalStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: portalStoreMock }));

const getPortalBoundsWithRetryMock = vi.hoisted(() => vi.fn());
vi.mock("../portalHelpers", () => ({
  getPortalBoundsWithRetry: getPortalBoundsWithRetryMock,
}));

const logErrorMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logError: logErrorMock }));

import { registerDevPreviewActions } from "../devPreviewActions";

const createMock = vi.fn(async () => ({}));
const showMock = vi.fn(async () => ({}));
const createTabMock = vi.fn(() => "tab-new");
const markTabCreatedMock = vi.fn();
const closeTabMock = vi.fn();
const setOpenMock = vi.fn();

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

function devPreviewPanel(overrides: Record<string, unknown> = {}) {
  return {
    id: "panel-1",
    kind: "dev-preview",
    title: "Preview",
    cwd: "/repo",
    worktreeId: "wt-1",
    browserUrl: "http://localhost:3000/",
    devServerUrl: "http://localhost:3000/",
    location: "grid",
    ...overrides,
  };
}

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerDevPreviewActions(actions, callbacks);
  return {
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
  getPortalBoundsWithRetryMock.mockResolvedValue(BOUNDS);
  panelStoreMock.getState.mockReturnValue({
    focusedId: "panel-1",
    getTerminal: vi.fn(() => devPreviewPanel()),
  });
  portalStoreMock.getState.mockReturnValue({
    isOpen: false,
    setOpen: setOpenMock,
    createTab: createTabMock,
    markTabCreated: markTabCreatedMock,
    closeTab: closeTabMock,
  });
  Object.defineProperty(globalThis.window, "electron", {
    value: { portal: { create: createMock, show: showMock } },
    configurable: true,
  });
});

describe("devPreview.promoteToPortal", () => {
  it("is registered as a safe command", () => {
    const { def } = setupActions();
    const d = def("devPreview.promoteToPortal");
    expect(d.danger).toBe("safe");
    expect(d.kind).toBe("command");
  });

  it("creates a portal tab sharing the dev-preview partition", async () => {
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });

    expect(setOpenMock).toHaveBeenCalledWith(true);
    expect(createTabMock).toHaveBeenCalledWith("http://localhost:3000/", "Preview");
    expect(createMock).toHaveBeenCalledWith({
      tabId: "tab-new",
      url: "http://localhost:3000/",
      partition: "persist:dev-preview-proj-wt-1-panel-1",
    });
    expect(markTabCreatedMock).toHaveBeenCalledWith("tab-new");
    expect(showMock).toHaveBeenCalledWith({ tabId: "tab-new", bounds: BOUNDS });
  });

  it("does not reopen the portal when already open", async () => {
    portalStoreMock.getState.mockReturnValue({
      isOpen: true,
      setOpen: setOpenMock,
      createTab: createTabMock,
      markTabCreated: markTabCreatedMock,
      closeTab: closeTabMock,
    });
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });
    expect(setOpenMock).not.toHaveBeenCalled();
  });

  it("falls back to devServerUrl when browserUrl is empty", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "panel-1",
      getTerminal: vi.fn(() =>
        devPreviewPanel({ browserUrl: "  ", devServerUrl: "http://localhost:4000/" })
      ),
    });
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });
    expect(createTabMock).toHaveBeenCalledWith("http://localhost:4000/", "Preview");
  });

  it("is a no-op when no URL has loaded", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "panel-1",
      getTerminal: vi.fn(() => devPreviewPanel({ browserUrl: undefined, devServerUrl: undefined })),
    });
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });
    expect(createTabMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("throws when the focused panel is not a dev preview", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "panel-1",
      getTerminal: vi.fn(() => ({ id: "panel-1", kind: "terminal", title: "T", location: "grid" })),
    });
    const { run } = setupActions();
    await expect(
      run("devPreview.promoteToPortal", undefined, { projectId: "proj" })
    ).rejects.toThrow(/not a dev preview/);
  });

  it("rolls back the tab when portal.create rejects", async () => {
    createMock.mockRejectedValueOnce(new Error("ipc boom"));
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });
    expect(closeTabMock).toHaveBeenCalledWith("tab-new");
    expect(markTabCreatedMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("throws when no project is open", async () => {
    const { run } = setupActions();
    await expect(run("devPreview.promoteToPortal")).rejects.toThrow(/No project/);
  });
});
