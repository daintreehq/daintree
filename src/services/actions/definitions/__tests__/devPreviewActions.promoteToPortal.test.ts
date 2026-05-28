// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));

const portalStoreMock = vi.hoisted(() => ({ getState: vi.fn(), setState: vi.fn() }));
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
const markTabCreatedMock = vi.fn();
const closeTabMock = vi.fn();
const setOpenMock = vi.fn();

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };
let portalState: { isOpen: boolean; tabs: unknown[]; activeTabId: string | null };
let order: string[];

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

function portalGetState() {
  return {
    isOpen: portalState.isOpen,
    setOpen: setOpenMock,
    markTabCreated: (id: string) => {
      order.push("markCreated");
      markTabCreatedMock(id);
    },
    closeTab: closeTabMock,
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
  order = [];
  portalState = { isOpen: false, tabs: [], activeTabId: null };
  getPortalBoundsWithRetryMock.mockResolvedValue(BOUNDS);
  panelStoreMock.getState.mockReturnValue({
    focusedId: "panel-1",
    getTerminal: vi.fn(() => devPreviewPanel()),
  });
  portalStoreMock.getState.mockImplementation(portalGetState);
  portalStoreMock.setState.mockImplementation((updater: (s: typeof portalState) => object) => {
    order.push("setState");
    Object.assign(portalState, updater(portalState));
  });
  createMock.mockImplementation(async () => {
    order.push("create");
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

  it("creates a portal tab on the dev-preview partition before activating it", async () => {
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });

    expect(setOpenMock).toHaveBeenCalledWith(true);
    // Critical race guard: the partitioned create must run before the tab is
    // inserted/activated so PortalVisibilityController never wins with a
    // partition-less create.
    expect(order.indexOf("create")).toBeLessThan(order.indexOf("setState"));

    const createArgs = createMock.mock.calls[0]![0] as {
      tabId: string;
      url: string;
      partition: string;
    };
    expect(createArgs.url).toBe("http://localhost:3000/");
    expect(createArgs.partition).toBe("persist:dev-preview-proj-wt-1-panel-1");

    expect(markTabCreatedMock).toHaveBeenCalledWith(createArgs.tabId);
    expect(portalState.activeTabId).toBe(createArgs.tabId);
    expect(portalState.tabs).toEqual([
      {
        id: createArgs.tabId,
        url: "http://localhost:3000/",
        title: "Preview",
        partition: "persist:dev-preview-proj-wt-1-panel-1",
      },
    ]);
    expect(showMock).toHaveBeenCalledWith({ tabId: createArgs.tabId, bounds: BOUNDS });
  });

  it("does not reopen the portal when already open", async () => {
    portalState.isOpen = true;
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
    const createArgs = createMock.mock.calls[0]![0] as { url: string };
    expect(createArgs.url).toBe("http://localhost:4000/");
  });

  it("is a no-op when no URL has loaded", async () => {
    panelStoreMock.getState.mockReturnValue({
      focusedId: "panel-1",
      getTerminal: vi.fn(() => devPreviewPanel({ browserUrl: undefined, devServerUrl: undefined })),
    });
    const { run } = setupActions();
    await run("devPreview.promoteToPortal", undefined, { projectId: "proj" });
    expect(createMock).not.toHaveBeenCalled();
    expect(portalStoreMock.setState).not.toHaveBeenCalled();
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
    expect(closeTabMock).toHaveBeenCalledTimes(1);
    expect(markTabCreatedMock).not.toHaveBeenCalled();
    expect(portalStoreMock.setState).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("throws when no project is open", async () => {
    const { run } = setupActions();
    await expect(run("devPreview.promoteToPortal")).rejects.toThrow(/No project/);
  });
});
