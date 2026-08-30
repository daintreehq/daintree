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
    // Default to the Cancel index. A failed open now offers a recovery action
    // at index 0, so defaulting to 0 would silently fire removals and reopens
    // inside tests that only mean to assert the dialog appeared.
    showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })),
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
  getProjectByPath: vi.fn<(path: string) => Promise<{ id: string; path: string } | null>>(
    async () => null
  ),
}));

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const removeProjectWithCleanupMock = vi.hoisted(() =>
  vi.fn<(projectId: string, deps: unknown) => Promise<void>>(async () => {})
);

vi.mock("../ipc/handlers/projectCrud/crud.js", () => ({
  removeProjectWithCleanup: removeProjectWithCleanupMock,
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
    NOTIFICATION_SHOW_TOAST: "notification:show-toast",
  },
}));

vi.mock("../../shared/config/agentRegistry.js", () => ({
  AGENT_REGISTRY: {},
  getEffectiveRegistry: vi.fn(() => ({})),
}));

vi.mock("../services/CliAvailabilityService.js", () => ({}));
vi.mock("../services/CliInstallService.js", () => ({}));
const finderQuickActionInstallMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
const finderQuickActionRemoveMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ removed: boolean; path: string }>>()
);
vi.mock("../services/FinderQuickActionService.js", () => ({
  install: finderQuickActionInstallMock,
  remove: finderQuickActionRemoveMock,
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
import {
  getProjectHistory,
  disposeProjectHistory,
  resetProjectHistory,
} from "../services/ProjectHistoryService.js";
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

/** Every item in the template, submenus included, so a chord can be searched for. */
function flattenMenuItems(
  template: readonly Electron.MenuItemConstructorOptions[]
): Electron.MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu)
      ? flattenMenuItems(item.submenu as Electron.MenuItemConstructorOptions[])
      : []),
  ]);
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
      // No accelerator: `Alt+CommandOrControl+I` belongs to the renderer's
      // `pilot.openProject` binding now, and a native menu accelerator eats the
      // keydown before the renderer ever sees it — a dev-only one here would
      // leave that shortcut working in the shipped app and dead on every
      // machine that develops or tests it (#11950).
      expect(item!.accelerator).toBeUndefined();
      // The invariant, not just this item's property: no menu item anywhere may
      // claim the chord, or the same collision comes back under another label.
      const flattened = flattenMenuItems(capturedTemplate);
      // Proof the walk actually reached into the submenus — an empty result
      // below would otherwise be true of a recursion that found nothing.
      expect(flattened).toContain(item);
      expect(flattened.filter((entry) => entry.accelerator === "Alt+CommandOrControl+I")).toEqual(
        []
      );
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
    // Revive window 7's history per test, and retire it afterwards even when a
    // test fails: a leftover tombstone silently makes the next test's switch
    // record nothing, which passes for the wrong reason.
    resetProjectHistory(7);
  });

  afterEach(() => {
    disposeProjectHistory(7);
  });

  it("records the scratch it is leaving behind the project it opens", async () => {
    // File → Open Recent stays reachable from a scratch, where the project
    // pointer this path used to read is null — so the scratch left no entry and
    // `Cmd+Alt+=` could not get back to it (#11936).
    const SCRATCH_ID = "11111111-1111-4111-8111-111111111111";
    const targetManager = createManager();
    targetManager.getActiveProjectId.mockReturnValue(SCRATCH_ID);
    windowRefMock.getWindowRegistry.mockReturnValue({
      getByWindowId: (id: number) =>
        id === 7 ? { services: { projectViewManager: targetManager } } : undefined,
      getPrimary: () => ({ services: { projectViewManager: targetManager } }),
    });

    const targetWindow = { id: 7, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
    await handleDirectoryOpen(PROJECT.path, targetWindow);

    expect(getProjectHistory(7).snapshot().entries).toEqual([PROJECT.id, SCRATCH_ID]);
    // Read before the swap: both warm activation and cold creation set
    // `activeProjectId` to the incoming project before `switchTo` resolves, so
    // capturing afterwards would record the destination as its own origin.
    expect(targetManager.getActiveProjectId.mock.invocationCallOrder[0]).toBeLessThan(
      targetManager.switchTo.mock.invocationCallOrder[0]!
    );
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

describe("Finder Quick Action menu item (#11406)", () => {
  const ITEM_LABEL = 'Install "Open in Daintree" Quick Action';
  const originalPlatform = process.platform;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  const REMOVE_ITEM_LABEL = 'Remove "Open in Daintree" Quick Action';

  function buildAndFind(
    label: string = ITEM_LABEL
  ): Electron.MenuItemConstructorOptions | undefined {
    capturedTemplate = [];
    createApplicationMenu(mockBrowserWindow as unknown as Electron.BrowserWindow);
    return findMenuItem(capturedTemplate, "Terminal", label);
  }

  async function clickItem(label: string): Promise<void> {
    const item = buildAndFind(label);
    await item!.click!(
      {} as Electron.MenuItem,
      mockBrowserWindow as unknown as Electron.BaseWindow,
      {} as Electron.KeyboardEvent
    );
  }

  function lastToast(): { type: string; title: string; message: string } | undefined {
    const call = mockWebContents.send.mock.calls.find(
      ([channel]) => channel === "notification:show-toast"
    );
    return call?.[1] as { type: string; title: string; message: string } | undefined;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    finderQuickActionInstallMock.mockReset();
    finderQuickActionRemoveMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("is enabled only on macOS", () => {
    setPlatform("darwin");
    expect(buildAndFind()?.enabled).toBe(true);

    // The Quick Action is a Finder feature; Windows and Linux reach the same
    // folder-open flow through their own installer/desktop-entry wiring.
    for (const platform of ["win32", "linux"]) {
      setPlatform(platform);
      expect(buildAndFind()?.enabled).toBe(false);
    }
  });

  it("installs the Quick Action and reports where it landed", async () => {
    setPlatform("darwin");
    const installPath = "/home/test/Library/Services/Open in Daintree.workflow";
    finderQuickActionInstallMock.mockResolvedValue(installPath);

    const item = buildAndFind();
    await item!.click!(
      {} as Electron.MenuItem,
      mockBrowserWindow as unknown as Electron.BaseWindow,
      {} as Electron.KeyboardEvent
    );

    expect(finderQuickActionInstallMock).toHaveBeenCalledOnce();
    const toast = mockWebContents.send.mock.calls.find(
      ([channel]) => channel === "notification:show-toast"
    );
    expect(toast?.[1]).toMatchObject({ type: "success", title: "Quick Action installed" });
    // The path is the only way a user can find or remove the installed bundle.
    expect((toast?.[1] as { message: string }).message).toContain(installPath);
  });

  it("surfaces an install failure instead of reporting success", async () => {
    setPlatform("darwin");
    finderQuickActionInstallMock.mockRejectedValue(new Error("Services directory is read-only"));

    const item = buildAndFind();
    await item!.click!(
      {} as Electron.MenuItem,
      mockBrowserWindow as unknown as Electron.BaseWindow,
      {} as Electron.KeyboardEvent
    );

    const toast = mockWebContents.send.mock.calls.find(
      ([channel]) => channel === "notification:show-toast"
    );
    expect(toast?.[1]).toMatchObject({ type: "error" });
    // The underlying reason must reach the user, not just a generic failure.
    expect((toast?.[1] as { message: string }).message).toContain("read-only");
  });

  it("offers removal alongside the install, on macOS only", () => {
    // Nothing else uninstalls the bundle: it lives in ~/Library/Services, which
    // the app installer never owns, so this menu item is the only inverse.
    setPlatform("darwin");
    expect(buildAndFind(REMOVE_ITEM_LABEL)?.enabled).toBe(true);

    for (const platform of ["win32", "linux"]) {
      setPlatform(platform);
      expect(buildAndFind(REMOVE_ITEM_LABEL)?.enabled).toBe(false);
    }
  });

  it("reports where the Quick Action was removed from", async () => {
    setPlatform("darwin");
    const quickActionPath = "/home/test/Library/Services/Open in Daintree.workflow";
    finderQuickActionRemoveMock.mockResolvedValue({ removed: true, path: quickActionPath });

    await clickItem(REMOVE_ITEM_LABEL);

    expect(finderQuickActionRemoveMock).toHaveBeenCalledOnce();
    expect(lastToast()).toMatchObject({ type: "success", title: "Quick Action removed" });
    expect(lastToast()?.message).toContain(quickActionPath);
  });

  it("does not claim a removal when nothing was installed", async () => {
    setPlatform("darwin");
    const quickActionPath = "/home/test/Library/Services/Open in Daintree.workflow";
    finderQuickActionRemoveMock.mockResolvedValue({ removed: false, path: quickActionPath });

    await clickItem(REMOVE_ITEM_LABEL);

    // Same happy path, different truth — the title must not say something was
    // removed when the service found nothing there.
    expect(lastToast()?.title).not.toBe("Quick Action removed");
    expect(lastToast()?.message).toContain(quickActionPath);
  });

  it("surfaces a removal failure instead of reporting success", async () => {
    setPlatform("darwin");
    finderQuickActionRemoveMock.mockRejectedValue(new Error("Operation not permitted"));

    await clickItem(REMOVE_ITEM_LABEL);

    expect(lastToast()).toMatchObject({ type: "error" });
    expect(lastToast()?.message).toContain("not permitted");
  });
});

// #11409: a failed open must explain itself in plain language, name the folder,
// and offer a way out — never hand the user simple-git's or GitService's
// internal wording in a dead-end OK box.
describe("handleDirectoryOpen failure dialogs", () => {
  const FOLDER = "/Volumes/Archive/repos/alpha";

  function targetWindowStub(): Electron.BrowserWindow {
    return { id: 3, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
  }

  /**
   * Read the options of the single dialog shown. Fields are pulled reflectively
   * because the mocked `showMessageBox` resolves to the one-argument overload,
   * so the window-plus-options call this code makes isn't indexable as a tuple.
   */
  function shownDialog(): {
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  } {
    const calls: unknown[][] = vi.mocked(dialog.showMessageBox).mock.calls;
    expect(calls).toHaveLength(1);
    const options = calls[0]?.[1];
    if (typeof options !== "object" || options === null) {
      throw new Error("expected showMessageBox to receive options");
    }
    const buttons: unknown = Reflect.get(options, "buttons");
    return {
      title: String(Reflect.get(options, "title")),
      message: String(Reflect.get(options, "message")),
      detail: String(Reflect.get(options, "detail")),
      buttons: Array.isArray(buttons) ? buttons.map(String) : [],
      defaultId: Number(Reflect.get(options, "defaultId")),
      cancelId: Number(Reflect.get(options, "cancelId")),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebContents.isDestroyed.mockReturnValue(false);
    mockWebContents.isLoadingMainFrame.mockReturnValue(false);
    getAppWebContentsMock.mockImplementation(() => mockWebContents);
    windowRefMock.getWindowRegistry.mockReturnValue(undefined);
    projectStoreMock.getProjectByPath.mockResolvedValue(null);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    });
  });

  it.each([
    ["NOT_FOUND"],
    ["NOT_A_DIRECTORY"],
    ["PERMISSION"],
    ["GIT_NOT_INSTALLED"],
    ["PROJECT_OPEN_FAILED"],
    ["INVALID_PATH"],
  ] as const)("never leaks internals when the open fails with %s", async (code) => {
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({
        code,
        // Whatever internal wording rides along on the error must not reach the
        // dialog — this string is exactly what #11409 reported seeing.
        message: "Git operation failed: getRepositoryRoot\nCannot use simple-git on a directory",
      })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    const opts = shownDialog();
    const shown = `${opts.title} ${opts.message} ${opts.detail}`;
    for (const banned of ["simple-git", "getRepositoryRoot", "Git operation failed"]) {
      expect(shown).not.toContain(banned);
    }
  });

  it("names the folder that failed", async () => {
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "NOT_FOUND", message: "gone" })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(shownDialog().detail).toContain(FOLDER);
  });

  it("offers one recovery action and a way out, defaulting to the way out", async () => {
    projectStoreMock.addProject.mockRejectedValue(
      new AppError({ code: "PERMISSION", message: "denied" })
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    const opts = shownDialog();
    expect(opts.buttons).toHaveLength(2);
    expect(opts.buttons[1]).toBe("Cancel");
    // Never a dead-end OK box, and never a destructive default.
    expect(opts.buttons[0]).not.toBe("OK");
    expect(opts.defaultId).toBe(1);
    expect(opts.cancelId).toBe(1);
  });

  it("keeps a raw error from reaching the dialog even when it isn't classified", async () => {
    // The pre-#11409 fallback assigned `error.message` straight to the dialog,
    // so an unclassified failure was the leak. It must now render safe copy.
    projectStoreMock.addProject.mockRejectedValue(
      new Error("Git operation failed: getRepositoryRoot")
    );

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    const opts = shownDialog();
    expect(`${opts.message} ${opts.detail}`).not.toContain("getRepositoryRoot");
    expect(opts.buttons[0]).toBe("Try again");
  });

  describe("a missing Recent Projects entry", () => {
    const PROJECT = { id: "project-a", path: FOLDER };

    beforeEach(() => {
      projectStoreMock.getProjectByPath.mockResolvedValue(PROJECT);
      projectStoreMock.addProject.mockRejectedValue(
        new AppError({ code: "NOT_FOUND", message: "gone" })
      );
      removeProjectWithCleanupMock.mockResolvedValue(undefined);
    });

    it("offers to remove the dead row instead of a folder picker", async () => {
      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(shownDialog().buttons[0]).toBe("Remove from recent");
    });

    it("removes it through the full teardown when confirmed", async () => {
      vi.mocked(dialog.showMessageBox).mockResolvedValue({
        response: 0,
        checkboxChecked: false,
      });

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      // Must go through the shared cleanup (PTY journal, window-state prune,
      // broadcast, menu refresh), not a bare row delete that orphans them.
      expect(removeProjectWithCleanupMock).toHaveBeenCalledTimes(1);
      expect(removeProjectWithCleanupMock.mock.calls[0][0]).toBe(PROJECT.id);
    });

    it("removes nothing when the user cancels", async () => {
      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(removeProjectWithCleanupMock).not.toHaveBeenCalled();
    });

    it("does not offer removal for a folder that is only unreachable", async () => {
      // A timeout or an I/O error proves the path didn't respond, not that it's
      // gone — deleting the project row on that evidence would destroy state.
      projectStoreMock.addProject.mockRejectedValue(
        new AppError({ code: "PROJECT_OPEN_FAILED", message: "timed out" })
      );

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(shownDialog().buttons[0]).toBe("Try again");
    });

    it("does not offer removal for a path that isn't a known project", async () => {
      projectStoreMock.getProjectByPath.mockResolvedValue(null);

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(shownDialog().buttons[0]).toBe("Choose another folder");
    });

    it("says what removing the project actually discards", async () => {
      await handleDirectoryOpen(FOLDER, targetWindowStub());

      // Removal drops saved state, so the dialog must not present it as merely
      // tidying up a list.
      expect(shownDialog().detail).toContain("settings");
    });

    it("tells the user when the removal is refused", async () => {
      // Removal fails closed when the pty-host can't confirm the project's
      // terminals stopped; logging that alone leaves the row with no
      // explanation.
      vi.mocked(dialog.showMessageBox).mockResolvedValue({
        response: 0,
        checkboxChecked: false,
      });
      removeProjectWithCleanupMock.mockRejectedValue(
        new AppError({ code: "INTERNAL", message: "Couldn't confirm the terminals stopped" })
      );

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      const calls: unknown[][] = vi.mocked(dialog.showMessageBox).mock.calls;
      expect(calls).toHaveLength(2);
      const followUp = calls[1]?.[1];
      if (typeof followUp !== "object" || followUp === null) {
        throw new Error("expected a follow-up dialog");
      }
      expect(String(Reflect.get(followUp, "detail"))).toContain(
        "Couldn't confirm the terminals stopped"
      );
    });

    it("still shows the failure when the project lookup itself fails", async () => {
      // The lookup only decides which recovery to offer; losing it must not
      // swallow the error the user needs to see.
      projectStoreMock.getProjectByPath.mockRejectedValue(new Error("db is down"));

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(shownDialog().buttons[0]).toBe("Choose another folder");
      expect(removeProjectWithCleanupMock).not.toHaveBeenCalled();
    });

    it("rebuilds the menu so the removed row leaves Recent Projects", async () => {
      vi.mocked(dialog.showMessageBox).mockResolvedValue({
        response: 0,
        checkboxChecked: false,
      });
      vi.mocked(Menu.setApplicationMenu).mockClear();

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      // Recent Projects is a static submenu; without a rebuild the dead entry
      // stays clickable after the user removes it.
      expect(Menu.setApplicationMenu).toHaveBeenCalled();
    });
  });

  describe("choosing a different folder", () => {
    beforeEach(() => {
      projectStoreMock.addProject.mockRejectedValue(
        new AppError({ code: "NOT_A_DIRECTORY", message: "a file" })
      );
      vi.mocked(dialog.showMessageBox).mockResolvedValue({
        response: 0,
        checkboxChecked: false,
      });
    });

    it("opens the picker and opens what the user chooses", async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: ["/repos/elsewhere"],
      });
      projectStoreMock.addProject
        .mockRejectedValueOnce(new AppError({ code: "NOT_A_DIRECTORY", message: "a file" }))
        .mockResolvedValueOnce({ id: "project-b", path: "/repos/elsewhere" });

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
      expect(projectStoreMock.addProject).toHaveBeenLastCalledWith("/repos/elsewhere");
    });

    it("does nothing further when the picker is cancelled", async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });

      await handleDirectoryOpen(FOLDER, targetWindowStub());

      expect(projectStoreMock.addProject).toHaveBeenCalledTimes(1);
    });
  });

  it("retries the same folder when the user asks to try again", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    projectStoreMock.addProject
      .mockRejectedValueOnce(new AppError({ code: "PERMISSION", message: "denied" }))
      .mockResolvedValueOnce({ id: "project-a", path: FOLDER });

    await handleDirectoryOpen(FOLDER, targetWindowStub());

    expect(projectStoreMock.addProject).toHaveBeenCalledTimes(2);
    expect(projectStoreMock.addProject.mock.calls[1][0]).toBe(FOLDER);
  });

  it("shows nothing if the window closed while the failure was being classified", async () => {
    let destroyed = false;
    projectStoreMock.addProject.mockImplementation(() => {
      destroyed = true;
      return Promise.reject(new AppError({ code: "NOT_FOUND", message: "gone" }));
    });

    await handleDirectoryOpen(FOLDER, {
      id: 3,
      isDestroyed: () => destroyed,
    } as unknown as Electron.BrowserWindow);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
