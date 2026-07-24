import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWebContents = vi.hoisted(() => ({
  toggleDevTools: vi.fn(),
  isDevToolsOpened: vi.fn(() => false),
  openDevTools: vi.fn(),
  closeDevTools: vi.fn(),
  reload: vi.fn(),
  reloadIgnoringCache: vi.fn(),
  setZoomLevel: vi.fn(),
  getZoomLevel: vi.fn(() => 1.0),
  isDestroyed: vi.fn(() => false),
  send: vi.fn(),
  isLoadingMainFrame: vi.fn(() => false),
  once: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  selectAll: vi.fn(),
}));

const mockFocusedWebContents = vi.hoisted(() => ({
  undo: vi.fn(),
  redo: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  selectAll: vi.fn(),
  isDestroyed: vi.fn(() => false),
}));

const mockBrowserWindow = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  id: 1,
}));

// setAboutPanelOptions runs once at menu.ts import time (module scope), before
// any beforeEach vi.clearAllMocks() can wipe the mock's call history — so
// capture the argument in a hoisted holder that survives the reset.
const aboutPanelCapture = vi.hoisted(() => ({
  options: undefined as Electron.AboutPanelOptionsOptions | undefined,
}));

let capturedTemplate: Electron.MenuItemConstructorOptions[] = [];

const menuItemRegistry = vi.hoisted(() => new Map<string, { label: string; enabled: boolean }>());
const mockApplicationMenu = vi.hoisted(() => ({
  getMenuItemById: vi.fn((id: string) => menuItemRegistry.get(id) ?? null),
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: Electron.MenuItemConstructorOptions[]) => {
      capturedTemplate = template;
      menuItemRegistry.clear();
      const collect = (items: Electron.MenuItemConstructorOptions[]): void => {
        for (const item of items) {
          if (item.id && typeof item.label === "string") {
            menuItemRegistry.set(item.id, {
              label: item.label,
              enabled: item.enabled ?? true,
            });
          }
          if (Array.isArray(item.submenu)) {
            collect(item.submenu as Electron.MenuItemConstructorOptions[]);
          }
        }
      };
      collect(template);
      return mockApplicationMenu;
    }),
    setApplicationMenu: vi.fn(),
    getApplicationMenu: vi.fn(() => mockApplicationMenu),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
  },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => "1.0.0"),
    setAboutPanelOptions: vi.fn((options: Electron.AboutPanelOptionsOptions) => {
      aboutPanelCapture.options = options;
    }),
    setPath: vi.fn(),
    getPath: vi.fn(() => "/mock/path"),
    commandLine: {
      appendSwitch: vi.fn(),
      appendArgument: vi.fn(),
    },
  },
  webContents: {
    getFocusedWebContents: vi.fn(() => mockFocusedWebContents),
  },
}));

const projectStoreMock = vi.hoisted(() => ({
  getAllProjects: vi.fn(() => []),
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  addProject: vi.fn<(path: string) => Promise<{ id: string; path: string }>>(),
  setCurrentProject: vi.fn<(id: string) => Promise<void>>(async () => {}),
  getProjectById: vi.fn<(id: string) => { id: string; path: string; status?: string } | null>(
    () => null
  ),
}));

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../ipc/projectSwitchBroadcast.js", () => ({
  broadcastProjectSwitchUpdates: vi.fn(),
}));

vi.mock("../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

vi.mock("../ipc/channels.js", () => ({
  CHANNELS: {
    MENU_ACTION: "menu-action",
    PROJECT_OPEN_GIT_INIT_DIALOG: "project:open-git-init-dialog",
  },
}));

vi.mock("../../shared/config/agentRegistry.js", () => ({
  AGENT_REGISTRY: {},
  getEffectiveRegistry: vi.fn(() => ({})),
}));

vi.mock("../services/CliAvailabilityService.js", () => ({}));
vi.mock("../services/CliInstallService.js", () => ({}));
vi.mock("../services/FinderQuickActionService.js", () => ({
  install: vi.fn<() => Promise<string>>(),
}));
vi.mock("../window/windowServices.js", () => ({
  getPtyClient: vi.fn(),
  getWorkspaceClientRef: vi.fn(),
  getWorktreePortBrokerRef: vi.fn(),
}));

const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn<() => unknown>(() => null),
  getProjectViewManager: vi.fn<() => unknown>(() => null),
}));

vi.mock("../window/windowRef.js", () => windowRefMock);

const toggleWindowFullscreenMock = vi.hoisted(() => vi.fn<(win: unknown) => boolean>(() => true));
vi.mock("../window/fullscreen.js", () => ({
  toggleWindowFullscreen: toggleWindowFullscreenMock,
}));

const autoUpdaterServiceMock = vi.hoisted(() => {
  let menuState: "idle" | "checking" | "ready" = "idle";
  return {
    checkForUpdatesManually: vi.fn(),
    quitAndInstallIfReady: vi.fn(),
    getMenuState: vi.fn(() => menuState),
    onMenuStateChange: vi.fn(() => vi.fn()),
    __setMenuState: (state: "idle" | "checking" | "ready") => {
      menuState = state;
    },
  };
});

vi.mock("../services/AutoUpdaterService.js", () => ({
  autoUpdaterService: autoUpdaterServiceMock,
}));

// menu.ts wires update-menu state through the deferred-loaded serviceRef, not
// a static AutoUpdaterService import. Return the mock so wiring stays
// synchronous in tests (mirrors the post-deferred-task state at runtime).
vi.mock("../window/serviceRefs.js", () => ({
  getAutoUpdaterServiceRef: vi.fn(() => autoUpdaterServiceMock),
}));

vi.mock("../services/pluginMenuRegistry.js", () => ({
  getPluginMenuItems: vi.fn(() => []),
}));

const getAppWebContentsMock = vi.hoisted(() =>
  vi.fn((_win: { id: number }): unknown => mockWebContents)
);

vi.mock("../window/webContentsRegistry.js", () => ({
  getAppWebContents: getAppWebContentsMock,
}));

const isWindowsStoreBuildMock = vi.hoisted(() => vi.fn(() => true));
// Keep the real build-channel helpers (getBuildChannel/getBuildChannelLabel)
// so the module-load About-panel wiring is exercised for real; only override
// the Windows Store detection the update-menu tests need to drive.
vi.mock("../../shared/config/distribution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/config/distribution.js")>()),
  isWindowsStoreBuild: isWindowsStoreBuildMock,
}));

import { createApplicationMenu, handleDirectoryOpen, buildAboutPanelOptions } from "../menu.js";
import { getBuildChannelLabel } from "../../shared/config/distribution.js";
import { webContents, app, Menu, dialog } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { AppError } from "../utils/errorTypes.js";

function findMenuItem(
  template: Electron.MenuItemConstructorOptions[],
  menuLabel: string,
  itemLabel: string
): Electron.MenuItemConstructorOptions | undefined {
  const menu = template.find((m) => m.label === menuLabel);
  if (!menu || !Array.isArray(menu.submenu)) return undefined;
  return (menu.submenu as Electron.MenuItemConstructorOptions[]).find((i) => i.label === itemLabel);
}

describe("About panel build channel (#11121)", () => {
  it("wires setAboutPanelOptions at import with the real running version", () => {
    // Captured at module import: app.getVersion() is mocked to "1.0.0", proving
    // the About options are actually applied (not dead code) and the raw
    // version flows through as applicationVersion.
    expect(aboutPanelCapture.options).toBeDefined();
    expect(aboutPanelCapture.options?.applicationVersion).toBe("1.0.0");
    expect(aboutPanelCapture.options?.version).toBe("");
  });

  describe("buildAboutPanelOptions", () => {
    it("passes the raw version through and leaves the build-version slot blank for stable builds", () => {
      const options = buildAboutPanelOptions("1.0.0");
      expect(options.applicationVersion).toBe("1.0.0");
      // Stable → no channel label → empty slot (no more hardcoded "Beta").
      expect(options.version).toBe("");
    });

    it("surfaces the channel label in the build-version slot for prerelease builds", () => {
      // Compare against the shared helper rather than duplicating label strings.
      for (const version of [
        "0.25.0-nightly.20260713120000.abc1234",
        "1.0.0-beta.1",
        "1.0.0-rc.2",
      ]) {
        const options = buildAboutPanelOptions(version);
        expect(options.applicationVersion).toBe(version);
        expect(options.version).toBe(getBuildChannelLabel(version));
        expect(options.version).toBeTruthy();
      }
    });
  });
});

describe("createApplicationMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTemplate = [];
    mockWebContents.getZoomLevel.mockReturnValue(1.0);
    mockWebContents.isDevToolsOpened.mockReturnValue(false);
    createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
  });

  describe("zoom items target getAppWebContents", () => {
    it("Actual Size resets zoom to 0", () => {
      const item = findMenuItem(capturedTemplate, "View", "Actual Size");
      expect(item).toBeDefined();
      expect(item!.accelerator).toBe("CommandOrControl+0");
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.setZoomLevel).toHaveBeenCalledWith(0);
    });

    it("Zoom In increments zoom by 0.5", () => {
      const item = findMenuItem(capturedTemplate, "View", "Zoom In");
      expect(item).toBeDefined();
      expect(item!.accelerator).toBe("CommandOrControl+=");
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.setZoomLevel).toHaveBeenCalledWith(1.5);
    });

    it("Zoom Out decrements zoom by 0.5", () => {
      const item = findMenuItem(capturedTemplate, "View", "Zoom Out");
      expect(item).toBeDefined();
      expect(item!.accelerator).toBe("CommandOrControl+-");
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.setZoomLevel).toHaveBeenCalledWith(0.5);
    });
  });

  describe("toggleDevTools targets getAppWebContents", () => {
    it("opens devtools in detach mode when closed", () => {
      mockWebContents.isDevToolsOpened.mockReturnValue(false);
      const item = findMenuItem(capturedTemplate, "View", "Toggle Developer Tools");
      expect(item).toBeDefined();
      expect(item!.accelerator).toBe("Alt+CommandOrControl+I");
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
      expect(mockWebContents.closeDevTools).not.toHaveBeenCalled();
    });

    it("closes devtools when already open", () => {
      mockWebContents.isDevToolsOpened.mockReturnValue(true);
      const item = findMenuItem(capturedTemplate, "View", "Toggle Developer Tools");
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.closeDevTools).toHaveBeenCalled();
      expect(mockWebContents.openDevTools).not.toHaveBeenCalled();
    });
  });

  describe("edit commands route to focused webContents", () => {
    const editItems = [
      { label: "Undo", method: "undo", accelerator: "CommandOrControl+Z" },
      { label: "Redo", method: "redo", accelerator: "CommandOrControl+Shift+Z" },
      { label: "Cut", method: "cut", accelerator: "CommandOrControl+X" },
      { label: "Copy", method: "copy", accelerator: "CommandOrControl+C" },
      { label: "Paste", method: "paste", accelerator: "CommandOrControl+V" },
      { label: "Select All", method: "selectAll", accelerator: "CommandOrControl+A" },
    ] as const;

    for (const { label, method, accelerator } of editItems) {
      it(`${label} calls ${method} on focused webContents`, () => {
        const item = findMenuItem(capturedTemplate, "Edit", label);
        expect(item).toBeDefined();
        expect(item!.accelerator).toBe(accelerator);
        item!.click!(
          {} as Electron.MenuItem,
          mockBrowserWindow as unknown as Electron.BaseWindow,
          {} as Electron.KeyboardEvent
        );
        expect(mockFocusedWebContents[method]).toHaveBeenCalled();
      });
    }

    it("no-ops when getFocusedWebContents returns null", () => {
      vi.mocked(webContents.getFocusedWebContents).mockReturnValueOnce(null as never);
      const item = findMenuItem(capturedTemplate, "Edit", "Copy");
      expect(() => {
        item!.click!(
          {} as Electron.MenuItem,
          mockBrowserWindow as unknown as Electron.BaseWindow,
          {} as Electron.KeyboardEvent
        );
      }).not.toThrow();
      expect(mockFocusedWebContents.copy).not.toHaveBeenCalled();
    });
  });

  describe("File menu Clone Repository item", () => {
    it("has a Clone Repository... item that sends clone-repo action", () => {
      const item = findMenuItem(capturedTemplate, "File", "Clone Repository…");
      expect(item).toBeDefined();
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.send).toHaveBeenCalledWith("menu-action", {
        actionId: "project.cloneRepo",
        args: undefined,
      });
    });
  });

  describe("File menu project-gated items", () => {
    afterEach(() => {
      // mockReturnValue survives vi.clearAllMocks(), so restore the defaults or an
      // active project leaks into every later test in this file.
      projectStoreMock.getCurrentProjectId.mockReturnValue(null);
      projectStoreMock.getProjectById.mockReturnValue(null);
    });

    // No window registry in this suite, so the menu resolver falls back to the
    // global pointer — but it still validates the row, so the project must exist.
    function rebuildWithProject(projectId: string | null): void {
      projectStoreMock.getCurrentProjectId.mockReturnValue(projectId);
      projectStoreMock.getProjectById.mockImplementation((id) =>
        projectId !== null && id === projectId
          ? { id: projectId, path: `/tmp/${projectId}`, status: "active" }
          : null
      );
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
    }

    function fileItem(label: string): Electron.MenuItemConstructorOptions {
      const item = findMenuItem(capturedTemplate, "File", label);
      expect(item).toBeDefined();
      return item!;
    }

    it("sends the project-settings action, not the app-settings one", () => {
      rebuildWithProject("project-1");
      fileItem("Project Settings…").click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.send).toHaveBeenCalledWith("menu-action", {
        actionId: "project.settings.open",
        args: undefined,
      });
    });

    it("enables both project items only while a project is open", () => {
      rebuildWithProject("project-1");
      expect(fileItem("Project Settings…").enabled).toBe(true);
      expect(fileItem("Close Project").enabled).toBe(true);

      rebuildWithProject(null);
      expect(fileItem("Project Settings…").enabled).toBe(false);
      expect(fileItem("Close Project").enabled).toBe(false);
    });

    it("disables both items when the pointed-at project row is closed", () => {
      // The pointer can outlive the open project: the row's status is what
      // decides, not the id's presence.
      projectStoreMock.getCurrentProjectId.mockReturnValue("project-1");
      projectStoreMock.getProjectById.mockReturnValue({
        id: "project-1",
        path: "/tmp/project-1",
        status: "closed",
      });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      expect(fileItem("Project Settings…").enabled).toBe(false);
      expect(fileItem("Close Project").enabled).toBe(false);
    });

    it("gives both items stable ids so the live refresh can address them", () => {
      rebuildWithProject("project-1");
      expect(fileItem("Project Settings…").id).toBe("file-project-settings");
      expect(fileItem("Close Project").id).toBe("file-close-project");
    });

    it("resolves the gate from repaired project rows, not a pre-repair snapshot", () => {
      vi.clearAllMocks();
      rebuildWithProject("project-1");

      // Building Open Recent calls getAllProjects(), which repairs stale status
      // rows as a side effect (a "closed" row that is still the current pointer
      // is promoted back to "active"). Resolving the gate first would snapshot
      // pre-repair rows and install a template the repair contradicts.
      expect(projectStoreMock.getAllProjects.mock.invocationCallOrder[0]).toBeLessThan(
        projectStoreMock.getCurrentProjectId.mock.invocationCallOrder[0]
      );
    });
  });

  describe("View menu Toggle Full Screen item", () => {
    it("delegates to the shared platform-aware fullscreen helper", () => {
      const item = findMenuItem(capturedTemplate, "View", "Toggle Full Screen");
      expect(item).toBeDefined();
      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(toggleWindowFullscreenMock).toHaveBeenCalledWith(mockBrowserWindow);
    });
  });

  describe("zoom items fallback to mainWindow when browserWindow is undefined", () => {
    it("Zoom In still works via mainWindow fallback", () => {
      mockWebContents.setZoomLevel.mockClear();
      const item = findMenuItem(capturedTemplate, "View", "Zoom In");
      item!.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
      expect(mockWebContents.setZoomLevel).toHaveBeenCalledWith(1.5);
    });
  });
});

describe("update menu lifecycle", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedTemplate = [];
    autoUpdaterServiceMock.__setMenuState("idle");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    Object.defineProperty(app, "isPackaged", { value: false, configurable: true });
  });

  function findUpdateItem(
    template: Electron.MenuItemConstructorOptions[],
    id: string
  ): Electron.MenuItemConstructorOptions | undefined {
    for (const top of template) {
      if (Array.isArray(top.submenu)) {
        for (const item of top.submenu as Electron.MenuItemConstructorOptions[]) {
          if (item.id === id) return item;
        }
      }
    }
    return undefined;
  }

  describe("on macOS (packaged)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
      isWindowsStoreBuildMock.mockReturnValue(false);
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
    });

    it("emits a Daintree-menu Check for Updates item with the canonical id", () => {
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");
      expect(item).toBeDefined();
      expect(item!.label).toBe("Check for Updates…");
    });

    it("does NOT emit a Help-menu Check for Updates item on darwin", () => {
      const item = findUpdateItem(capturedTemplate, "check-for-updates-help");
      expect(item).toBeUndefined();
    });

    it("registers a menu-state listener after Menu.setApplicationMenu", () => {
      expect(autoUpdaterServiceMock.onMenuStateChange).toHaveBeenCalled();
    });

    it("applies the current state immediately after rebuild (sticky Ready)", () => {
      autoUpdaterServiceMock.__setMenuState("ready");
      capturedTemplate = [];
      menuItemRegistry.clear();

      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const item = menuItemRegistry.get("check-for-updates-mac");
      expect(item).toBeDefined();
      expect(item!.label).toBe("Restart to Install Update");
      expect(item!.enabled).toBe(true);
    });

    it("disposes the previous listener when createApplicationMenu is called again", () => {
      const firstUnsubscribe = vi.fn();
      const secondUnsubscribe = vi.fn();
      autoUpdaterServiceMock.onMenuStateChange.mockReturnValueOnce(firstUnsubscribe);
      autoUpdaterServiceMock.onMenuStateChange.mockReturnValueOnce(secondUnsubscribe);

      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
      expect(secondUnsubscribe).not.toHaveBeenCalled();
    });
  });

  describe("on linux (packaged)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
      isWindowsStoreBuildMock.mockReturnValue(false);
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
    });

    it("emits a Help-menu Check for Updates item with the canonical id", () => {
      const item = findUpdateItem(capturedTemplate, "check-for-updates-help");
      expect(item).toBeDefined();
      expect(item!.label).toBe("Check for Updates…");
    });

    it("does NOT emit a Daintree-menu Check for Updates item on non-darwin", () => {
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");
      expect(item).toBeUndefined();
    });
  });

  describe("on Windows Store builds (packaged)", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      // isWindowsStoreBuild() now reads process.windowsStore — only MSIX/AppX
      // containers set this. Simulate the Store path here so the in-app
      // updater menu items are suppressed.
      Object.defineProperty(process, "windowsStore", { value: true, configurable: true });
      Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
      isWindowsStoreBuildMock.mockReturnValue(true);
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
    });

    afterEach(() => {
      // Reset between describe blocks so the NSIS/non-Store path tests start
      // with windowsStore undefined.
      Reflect.deleteProperty(process, "windowsStore");
    });

    it("does NOT emit a Help-menu Check for Updates item", () => {
      const item = findUpdateItem(capturedTemplate, "check-for-updates-help");
      expect(item).toBeUndefined();
    });

    it("does NOT emit a Daintree-menu Check for Updates item", () => {
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");
      expect(item).toBeUndefined();
    });
  });

  describe("click handler branching", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
      isWindowsStoreBuildMock.mockReturnValue(false);
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
    });

    // The click handler dynamic-imports AutoUpdaterService (keeping
    // electron-updater off the boot path), so the branch runs a microtask
    // after the click — flush before asserting.
    const flushClick = () => new Promise((resolve) => setImmediate(resolve));

    it("calls checkForUpdatesManually when state is idle", async () => {
      autoUpdaterServiceMock.__setMenuState("idle");
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");

      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      await flushClick();

      expect(autoUpdaterServiceMock.checkForUpdatesManually).toHaveBeenCalledTimes(1);
      expect(autoUpdaterServiceMock.quitAndInstallIfReady).not.toHaveBeenCalled();
    });

    it("calls checkForUpdatesManually when state is checking (defensive — item is also disabled)", async () => {
      autoUpdaterServiceMock.__setMenuState("checking");
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");

      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      await flushClick();

      expect(autoUpdaterServiceMock.checkForUpdatesManually).toHaveBeenCalledTimes(1);
      expect(autoUpdaterServiceMock.quitAndInstallIfReady).not.toHaveBeenCalled();
    });

    it("calls quitAndInstallIfReady when state is ready", async () => {
      autoUpdaterServiceMock.__setMenuState("ready");
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");

      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      await flushClick();

      expect(autoUpdaterServiceMock.quitAndInstallIfReady).toHaveBeenCalledTimes(1);
      expect(autoUpdaterServiceMock.checkForUpdatesManually).not.toHaveBeenCalled();
    });
  });

  describe("Window submenu platform conditioning (#7939)", () => {
    function findSubmenu(
      template: Electron.MenuItemConstructorOptions[],
      label: string
    ): Electron.MenuItemConstructorOptions[] {
      const top = template.find((m) => m.label === label);
      if (!top || !Array.isArray(top.submenu)) {
        throw new Error(`Expected submenu for "${label}"`);
      }
      return top.submenu as Electron.MenuItemConstructorOptions[];
    }

    it("on darwin keeps the original [minimize, zoom, separator, front] submenu", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const items = findSubmenu(capturedTemplate, "Window");
      expect(items.map((i) => i.role ?? i.type)).toEqual([
        "minimize",
        "zoom",
        "separator",
        "front",
      ]);
    });

    it("on win32 replaces the macOS-only roles with [minimize, close] and no orphan separator", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const items = findSubmenu(capturedTemplate, "Window");
      expect(items.map((i) => i.role ?? i.type)).toEqual(["minimize", "close"]);
      expect(items.some((i) => i.role === "zoom")).toBe(false);
      expect(items.some((i) => i.role === "front")).toBe(false);
      expect(items.some((i) => i.type === "separator")).toBe(false);
    });

    it("on linux replaces the macOS-only roles with [minimize, close] and no orphan separator", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const items = findSubmenu(capturedTemplate, "Window");
      expect(items.map((i) => i.role ?? i.type)).toEqual(["minimize", "close"]);
    });
  });

  describe("File menu Exit and Settings accelerator on non-darwin (#7939)", () => {
    it("on darwin: no Exit item, no Settings... with accelerator (Settings... lives in app menu)", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const fileMenu = capturedTemplate.find((m) => m.label === "File");
      const items = fileMenu!.submenu as Electron.MenuItemConstructorOptions[];
      expect(items.some((i) => i.label === "Exit")).toBe(false);
      const fileSettings = items.find(
        (i) => i.label === "Settings…" && i.accelerator === "CommandOrControl+,"
      );
      expect(fileSettings).toBeUndefined();
    });

    it("on win32: File menu ends with separator + Exit (role: quit) and exposes Settings... with CommandOrControl+,", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const fileMenu = capturedTemplate.find((m) => m.label === "File");
      const items = fileMenu!.submenu as Electron.MenuItemConstructorOptions[];

      const last = items[items.length - 1];
      const penultimate = items[items.length - 2];
      expect(last.label).toBe("Exit");
      expect(last.role).toBe("quit");
      expect(penultimate.type).toBe("separator");

      const settings = items.find((i) => i.label === "Settings…");
      expect(settings).toBeDefined();
      expect(settings!.accelerator).toBe("CommandOrControl+,");
    });

    it("on linux: File menu ends with separator + Exit (role: quit) and exposes Settings... with CommandOrControl+,", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const fileMenu = capturedTemplate.find((m) => m.label === "File");
      const items = fileMenu!.submenu as Electron.MenuItemConstructorOptions[];

      const last = items[items.length - 1];
      expect(last.label).toBe("Exit");
      expect(last.role).toBe("quit");

      const settings = items.find((i) => i.label === "Settings…");
      expect(settings).toBeDefined();
      expect(settings!.accelerator).toBe("CommandOrControl+,");
    });

    it("Settings... on non-darwin dispatches open-settings", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const fileMenu = capturedTemplate.find((m) => m.label === "File");
      const items = fileMenu!.submenu as Electron.MenuItemConstructorOptions[];
      const settings = items.find((i) => i.label === "Settings…");
      expect(settings).toBeDefined();

      settings!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );
      expect(mockWebContents.send).toHaveBeenCalledWith("menu-action", {
        actionId: "app.settings",
        args: undefined,
      });
    });
  });

  describe("Help menu About item on non-darwin (#7939)", () => {
    function findHelpSubmenu(
      template: Electron.MenuItemConstructorOptions[]
    ): Electron.MenuItemConstructorOptions[] {
      const top = template.find((m) => m.role === "help");
      if (!top || !Array.isArray(top.submenu)) {
        throw new Error("Expected Help submenu");
      }
      return top.submenu as Electron.MenuItemConstructorOptions[];
    }

    it("on darwin: no About item in Help (About lives in the Daintree app menu)", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const items = findHelpSubmenu(capturedTemplate);
      expect(items.some((i) => i.role === "about")).toBe(false);
    });

    it("on win32: About is the last item in Help, preceded by a separator", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const items = findHelpSubmenu(capturedTemplate);
      const last = items[items.length - 1];
      const penultimate = items[items.length - 2];
      expect(last.role).toBe("about");
      expect(penultimate.type).toBe("separator");
    });

    it("on linux: About is the last item in Help, preceded by a separator", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const items = findHelpSubmenu(capturedTemplate);
      const last = items[items.length - 1];
      const penultimate = items[items.length - 2];
      expect(last.role).toBe("about");
      expect(penultimate.type).toBe("separator");
    });
  });

  describe("applyUpdateMenuState (via the registered listener)", () => {
    let dispatchUpdate: (state: "idle" | "checking" | "ready") => void;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      Object.defineProperty(app, "isPackaged", { value: true, configurable: true });
      isWindowsStoreBuildMock.mockReturnValue(false);
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      // The most-recent createApplicationMenu call registers the listener via
      // onMenuStateChange; pull it back out of the mock's call history.
      const calls = autoUpdaterServiceMock.onMenuStateChange.mock.calls;
      if (calls.length === 0) throw new Error("expected onMenuStateChange to be called");
      const lastCall = calls[calls.length - 1] as unknown[] | undefined;
      if (!lastCall || !lastCall[0]) throw new Error("expected callback argument");
      dispatchUpdate = lastCall[0] as (state: "idle" | "checking" | "ready") => void;
    });

    it("checking state sets disabled label", () => {
      dispatchUpdate("checking");
      const item = menuItemRegistry.get("check-for-updates-mac");
      expect(item!.label).toBe("Checking…");
      expect(item!.enabled).toBe(false);
    });

    it("ready state sets restart label", () => {
      dispatchUpdate("ready");
      const item = menuItemRegistry.get("check-for-updates-mac");
      expect(item!.label).toBe("Restart to Install Update");
      expect(item!.enabled).toBe(true);
    });

    it("idle state restores default label", () => {
      dispatchUpdate("checking");
      dispatchUpdate("idle");
      const item = menuItemRegistry.get("check-for-updates-mac");
      expect(item!.label).toBe("Check for Updates…");
      expect(item!.enabled).toBe(true);
    });

    it("does not throw when getApplicationMenu returns null", () => {
      vi.mocked(Menu.getApplicationMenu).mockReturnValueOnce(null as never);

      expect(() => dispatchUpdate("checking")).not.toThrow();
    });
  });
});

// #11100: handleDirectoryOpen reached for the process-global ProjectViewManager,
// which every new window overwrites. Opening a directory from an older window's
// menu therefore switched the newest window's view instead of the one the user
// clicked in.
describe("handleDirectoryOpen window targeting", () => {
  const PROJECT = { id: "project-a", path: "/repos/alpha" };

  function createManager() {
    return {
      switchTo: vi.fn(async () => ({
        view: { webContents: { isDestroyed: () => false, send: vi.fn() } },
        isNew: true,
      })),
      getActiveProjectId: vi.fn<() => string | null>(() => null),
      getOutgoingBridgeProjectId: vi.fn<() => string | null>(() => null),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.addProject.mockResolvedValue(PROJECT);
    projectStoreMock.getProjectById.mockReturnValue(PROJECT);
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
  });

  it("switches the view of the window the menu action came from, not the newest window", async () => {
    const targetManager = createManager();
    const newestManager = createManager();

    // The user clicked in window 7; window 9 was created most recently, so it
    // owns the global slot.
    windowRefMock.getWindowRegistry.mockReturnValue({
      getByWindowId: (id: number) =>
        id === 7 ? { services: { projectViewManager: targetManager } } : undefined,
      // handleDirectoryOpen rebuilds the menu, and the rebuild resolves the
      // project gates against the focused window.
      getPrimary: () => ({ services: { projectViewManager: targetManager } }),
    });
    windowRefMock.getProjectViewManager.mockReturnValue(newestManager);

    const targetWindow = { id: 7, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
    await handleDirectoryOpen(PROJECT.path, targetWindow);

    expect(targetManager.switchTo).toHaveBeenCalledWith(PROJECT.id, PROJECT.path);
    expect(newestManager.switchTo).not.toHaveBeenCalled();
  });
});

// #11281: a folder that isn't a repository yet must route to the renderer's
// guided GitInitDialog instead of the dead-end native error box, for every entry
// point that funnels through handleDirectoryOpen (Dock drop, Cmd+O, Recent).
describe("handleDirectoryOpen non-repository folders", () => {
  const FOLDER = "/repos/not-a-repo";

  function targetWindowStub(): Electron.BrowserWindow {
    return { id: 3, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` drops call history but keeps implementations, so restore
    // the defaults the per-test overrides below replace.
    mockWebContents.isDestroyed.mockReturnValue(false);
    mockWebContents.isLoadingMainFrame.mockReturnValue(false);
    getAppWebContentsMock.mockImplementation(() => mockWebContents);
    windowRefMock.getWindowRegistry.mockReturnValue(undefined);
  });

  it("opens the guided dialog instead of the native error box", async () => {
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "NOT_A_GIT_REPO", message: `Not a git repository: ${FOLDER}` })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(mockWebContents.send).toHaveBeenCalledTimes(1);
    expect(mockWebContents.send).toHaveBeenCalledWith(CHANNELS.PROJECT_OPEN_GIT_INIT_DIALOG, {
      directoryPath: FOLDER,
    });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("defers the send until the renderer finishes loading", async () => {
    mockWebContents.isLoadingMainFrame.mockReturnValue(true);
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "NOT_A_GIT_REPO", message: "Not a git repository" })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    // A cold-launch Dock drop opens the folder while the window is still
    // loading; Electron drops sends made before `did-finish-load` with no queue.
    expect(mockWebContents.send).not.toHaveBeenCalled();
    expect(mockWebContents.once).toHaveBeenCalledTimes(1);

    const [event, deferredSend] = mockWebContents.once.mock.calls[0] as [string, () => void];
    expect(event).toBe("did-finish-load");

    deferredSend();
    expect(mockWebContents.send).toHaveBeenCalledWith(CHANNELS.PROJECT_OPEN_GIT_INIT_DIALOG, {
      directoryPath: FOLDER,
    });
  });

  it("drops the deferred send if the renderer is destroyed before it fires", async () => {
    mockWebContents.isLoadingMainFrame.mockReturnValue(true);
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "NOT_A_GIT_REPO", message: "Not a git repository" })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    const [, deferredSend] = mockWebContents.once.mock.calls[0] as [string, () => void];
    mockWebContents.isDestroyed.mockReturnValue(true);
    deferredSend();

    expect(mockWebContents.send).not.toHaveBeenCalled();
  });

  it("still shows the native error box for unrelated failures", async () => {
    projectStoreMock.addProject.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(mockWebContents.send).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("does not hijack unrelated structured errors", async () => {
    // Guards the `error.code` half of the condition: matching on `isAppError`
    // alone would route a genuine failure into git-init setup and swallow it.
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "INTERNAL", message: "Something else broke" })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(mockWebContents.send).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("sends to the window the open came from, not a global one", async () => {
    const otherWindowContents = {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
    };
    getAppWebContentsMock.mockImplementation((win: { id: number }) =>
      win.id === 3 ? mockWebContents : otherWindowContents
    );
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "NOT_A_GIT_REPO", message: "Not a git repository" })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(mockWebContents.send).toHaveBeenCalledTimes(1);
    expect(otherWindowContents.send).not.toHaveBeenCalled();
  });

  it("gives up if the window closes while the folder is being resolved", async () => {
    // `addProject` is async, so the user can close the window mid-flight; the
    // renderer lookup must not run against a dead window.
    let destroyed = false;
    projectStoreMock.addProject.mockImplementation(() => {
      destroyed = true;
      return Promise.reject(
        new AppError({ code: "NOT_A_GIT_REPO", message: "Not a git repository" })
      );
    });
    const closingWindow = {
      id: 3,
      isDestroyed: () => destroyed,
    } as unknown as Electron.BrowserWindow;

    await handleDirectoryOpen(FOLDER, closingWindow);

    expect(getAppWebContentsMock).not.toHaveBeenCalled();
    expect(mockWebContents.send).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("keys the guided path to the error code, not the message text", async () => {
    // An untyped error that merely mentions the phrase (e.g. surfaced by some
    // other git call) must keep the old native-dialog behavior — only the
    // structured NOT_A_GIT_REPO code means "this folder can be initialized".
    projectStoreMock.addProject.mockRejectedValue(new Error("Not a git repository: elsewhere"));

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(mockWebContents.send).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
