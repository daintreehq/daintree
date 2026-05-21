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
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => "1.0.0"),
    setAboutPanelOptions: vi.fn(),
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

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

vi.mock("../ipc/channels.js", () => ({
  CHANNELS: { MENU_ACTION: "menu-action" },
}));

vi.mock("../../shared/config/agentRegistry.js", () => ({
  AGENT_REGISTRY: {},
  getEffectiveRegistry: vi.fn(() => ({})),
}));

vi.mock("../services/CliAvailabilityService.js", () => ({}));
vi.mock("../services/CliInstallService.js", () => ({}));
vi.mock("../window/windowServices.js", () => ({
  getPtyClient: vi.fn(),
  getWorkspaceClientRef: vi.fn(),
  getWorktreePortBrokerRef: vi.fn(),
}));

vi.mock("../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
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

vi.mock("../services/pluginMenuRegistry.js", () => ({
  getPluginMenuItems: vi.fn(() => []),
}));

vi.mock("../window/webContentsRegistry.js", () => ({
  getAppWebContents: vi.fn(() => mockWebContents),
}));

const isWindowsStoreBuildMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../shared/config/distribution.js", () => ({
  isWindowsStoreBuild: isWindowsStoreBuildMock,
}));

import { createApplicationMenu } from "../menu.js";
import { webContents, app, Menu } from "electron";

function findMenuItem(
  template: Electron.MenuItemConstructorOptions[],
  menuLabel: string,
  itemLabel: string
): Electron.MenuItemConstructorOptions | undefined {
  const menu = template.find((m) => m.label === menuLabel);
  if (!menu || !Array.isArray(menu.submenu)) return undefined;
  return (menu.submenu as Electron.MenuItemConstructorOptions[]).find((i) => i.label === itemLabel);
}

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
      const item = findMenuItem(capturedTemplate, "File", "Clone Repository...");
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
      expect(item!.label).toBe("Restart to install update");
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

    it("calls checkForUpdatesManually when state is idle", () => {
      autoUpdaterServiceMock.__setMenuState("idle");
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");

      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );

      expect(autoUpdaterServiceMock.checkForUpdatesManually).toHaveBeenCalledTimes(1);
      expect(autoUpdaterServiceMock.quitAndInstallIfReady).not.toHaveBeenCalled();
    });

    it("calls checkForUpdatesManually when state is checking (defensive — item is also disabled)", () => {
      autoUpdaterServiceMock.__setMenuState("checking");
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");

      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );

      expect(autoUpdaterServiceMock.checkForUpdatesManually).toHaveBeenCalledTimes(1);
      expect(autoUpdaterServiceMock.quitAndInstallIfReady).not.toHaveBeenCalled();
    });

    it("calls quitAndInstallIfReady when state is ready", () => {
      autoUpdaterServiceMock.__setMenuState("ready");
      const item = findUpdateItem(capturedTemplate, "check-for-updates-mac");

      item!.click!(
        {} as Electron.MenuItem,
        mockBrowserWindow as unknown as Electron.BaseWindow,
        {} as Electron.KeyboardEvent
      );

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
        (i) => i.label === "Settings..." && i.accelerator === "CommandOrControl+,"
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

      const settings = items.find((i) => i.label === "Settings...");
      expect(settings).toBeDefined();
      expect(settings!.accelerator).toBe("CommandOrControl+,");

      expect(items.some((i) => i.label === "Project Settings")).toBe(true);
    });

    it("on linux: File menu ends with separator + Exit (role: quit) and exposes Settings... with CommandOrControl+,", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const fileMenu = capturedTemplate.find((m) => m.label === "File");
      const items = fileMenu!.submenu as Electron.MenuItemConstructorOptions[];

      const last = items[items.length - 1];
      expect(last.label).toBe("Exit");
      expect(last.role).toBe("quit");

      const settings = items.find((i) => i.label === "Settings...");
      expect(settings).toBeDefined();
      expect(settings!.accelerator).toBe("CommandOrControl+,");
    });

    it("Settings... on non-darwin dispatches open-settings", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);

      const fileMenu = capturedTemplate.find((m) => m.label === "File");
      const items = fileMenu!.submenu as Electron.MenuItemConstructorOptions[];
      const settings = items.find((i) => i.label === "Settings...");
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
      expect(item!.label).toBe("Restart to install update");
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
