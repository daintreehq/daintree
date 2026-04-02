import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: Electron.MenuItemConstructorOptions[]) => {
      capturedTemplate = template;
      return {};
    }),
    setApplicationMenu: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => "1.0.0"),
    setAboutPanelOptions: vi.fn(),
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
  getEffectiveRegistry: vi.fn(() => ({})),
}));

vi.mock("../services/CliAvailabilityService.js", () => ({}));
vi.mock("../services/CliInstallService.js", () => ({}));

vi.mock("../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
}));

vi.mock("../services/AutoUpdaterService.js", () => ({
  autoUpdaterService: { checkForUpdatesManually: vi.fn() },
}));

vi.mock("../services/pluginMenuRegistry.js", () => ({
  getPluginMenuItems: vi.fn(() => []),
}));

vi.mock("../window/webContentsRegistry.js", () => ({
  getAppWebContents: vi.fn(() => mockWebContents),
}));

import { createApplicationMenu } from "../menu.js";
import { webContents } from "electron";

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

  describe("zoom items fallback to mainWindow when browserWindow is undefined", () => {
    it("Zoom In still works via mainWindow fallback", () => {
      mockWebContents.setZoomLevel.mockClear();
      const item = findMenuItem(capturedTemplate, "View", "Zoom In");
      item!.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
      expect(mockWebContents.setZoomLevel).toHaveBeenCalledWith(1.5);
    });
  });
});
