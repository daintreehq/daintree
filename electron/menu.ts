import { Menu, dialog, BrowserWindow, shell, app, webContents } from "electron";
import { projectStore } from "./services/ProjectStore.js";
import { CHANNELS } from "./ipc/channels.js";
import { getEffectiveRegistry } from "../shared/config/agentRegistry.js";
import type { CliAvailabilityService } from "./services/CliAvailabilityService.js";
import * as CliInstallService from "./services/CliInstallService.js";
import { getWindowRegistry, getProjectViewManager } from "./window/windowRef.js";
import { autoUpdaterService } from "./services/AutoUpdaterService.js";
import { getPluginMenuItems } from "./services/pluginMenuRegistry.js";
import { getAppWebContents } from "./window/webContentsRegistry.js";

app.setAboutPanelOptions({
  applicationName: "Canopy",
  applicationVersion: app.getVersion(),
  version: "Beta",
  copyright: `© ${new Date().getFullYear()} Canopy Team`,
  website: "https://github.com/canopyide/canopy",
});

function convertShortcutToAccelerator(shortcut: string): string {
  return shortcut.replace("Cmd/Ctrl", "CommandOrControl");
}

export function createApplicationMenu(
  mainWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): void {
  const getTargetBrowserWindow = (
    browserWindow: Electron.BaseWindow | undefined
  ): BrowserWindow | null => {
    if (browserWindow instanceof BrowserWindow && !browserWindow.isDestroyed()) {
      return browserWindow;
    }

    if (!mainWindow.isDestroyed()) {
      return mainWindow;
    }

    return null;
  };

  const sendAction = (action: string, target: BrowserWindow | null) => {
    if (target && !target.isDestroyed()) {
      const wc = getAppWebContents(target);
      if (!wc.isDestroyed()) {
        try {
          wc.send(CHANNELS.MENU_ACTION, action);
        } catch {
          // Silently ignore send failures during window disposal.
        }
      }
    }
  };

  const availability = cliAvailabilityService?.getAvailability();

  const buildAgentMenuItems = (): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [];

    Object.values(getEffectiveRegistry()).forEach((agent) => {
      const isAvailable = availability?.[agent.id] ?? false;

      if (isAvailable) {
        items.push({
          label: `New ${agent.name}`,
          accelerator: agent.shortcut ? convertShortcutToAccelerator(agent.shortcut) : undefined,
          click: (_item, browserWindow) =>
            sendAction(`launch-agent:${agent.id}`, getTargetBrowserWindow(browserWindow)),
        });
      }
    });

    return items;
  };

  const buildPluginMenuItems = (location: string): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    for (const { item } of getPluginMenuItems()) {
      if (item.location !== location) continue;
      items.push({
        label: item.label,
        accelerator: item.accelerator ? convertShortcutToAccelerator(item.accelerator) : undefined,
        click: (_item, browserWindow) =>
          sendAction(`plugin:${item.actionId}`, getTargetBrowserWindow(browserWindow)),
      });
    }
    return items;
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Directory...",
          accelerator: "CommandOrControl+O",
          click: async (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            const result = await dialog.showOpenDialog(win, {
              properties: ["openDirectory", "createDirectory"],
              title: "Open Git Repository",
            });

            if (!result.canceled && result.filePaths.length > 0) {
              const directoryPath = result.filePaths[0];
              await handleDirectoryOpen(directoryPath, win, cliAvailabilityService);
            }
          },
        },
        {
          label: "New Window",
          accelerator: "CommandOrControl+Shift+Alt+N",
          click: (_item, browserWindow) =>
            sendAction("new-window", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "New Worktree...",
          accelerator: "CommandOrControl+N",
          click: (_item, browserWindow) =>
            sendAction("new-worktree", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "Open Recent",
          submenu: buildRecentProjectsMenu(getTargetBrowserWindow, cliAvailabilityService),
        },
        { type: "separator" },
        {
          label: "Project Settings",
          click: (_item, browserWindow) =>
            sendAction("open-settings", getTargetBrowserWindow(browserWindow)),
        },
        ...(buildPluginMenuItems("file").length > 0
          ? [{ type: "separator" as const }, ...buildPluginMenuItems("file")]
          : []),
        { type: "separator" },
        {
          label: "Close Window",
          role: "close",
          registerAccelerator: false,
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CommandOrControl+Z",
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.undo();
          },
        },
        {
          label: "Redo",
          accelerator: "CommandOrControl+Shift+Z",
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.redo();
          },
        },
        { type: "separator" },
        {
          label: "Cut",
          accelerator: "CommandOrControl+X",
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.cut();
          },
        },
        {
          label: "Copy",
          accelerator: "CommandOrControl+C",
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.copy();
          },
        },
        {
          label: "Paste",
          accelerator: "CommandOrControl+V",
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.paste();
          },
        },
        {
          label: "Select All",
          accelerator: "CommandOrControl+A",
          click: () => {
            const focused = webContents.getFocusedWebContents();
            if (focused && !focused.isDestroyed()) focused.selectAll();
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CommandOrControl+B",
          click: (_item, browserWindow) =>
            sendAction("toggle-sidebar", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Reload",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            getAppWebContents(win).reload();
          },
        },
        {
          label: "Force Reload",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            getAppWebContents(win).reloadIgnoringCache();
          },
        },
        ...(app.isPackaged
          ? []
          : [
              {
                label: "Toggle Developer Tools",
                accelerator: "Alt+CommandOrControl+I",
                click: (
                  _item: Electron.MenuItem,
                  browserWindow: Electron.BaseWindow | undefined
                ) => {
                  const win = getTargetBrowserWindow(browserWindow);
                  if (!win) return;
                  getAppWebContents(win).toggleDevTools();
                },
              },
            ]),
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CommandOrControl+0",
          click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            getAppWebContents(win).setZoomLevel(0);
          },
        },
        {
          label: "Zoom In",
          accelerator: "CommandOrControl+=",
          click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            const wc = getAppWebContents(win);
            wc.setZoomLevel(wc.getZoomLevel() + 0.5);
          },
        },
        {
          label: "Zoom Out",
          accelerator: "CommandOrControl+-",
          click: (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            const wc = getAppWebContents(win);
            wc.setZoomLevel(wc.getZoomLevel() - 0.5);
          },
        },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          accelerator: process.platform === "darwin" ? "Ctrl+Cmd+F" : "F11",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            // Use simpleFullScreen for pre-Lion behavior that extends into the notch area
            const isSimpleFullScreen = win.isSimpleFullScreen();
            win.setSimpleFullScreen(!isSimpleFullScreen);
          },
        },
        ...(buildPluginMenuItems("view").length > 0
          ? [{ type: "separator" as const }, ...buildPluginMenuItems("view")]
          : []),
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "Duplicate Panel",
          accelerator: "CommandOrControl+T",
          click: (_item, browserWindow) =>
            sendAction("duplicate-panel", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "New Terminal",
          accelerator: "CommandOrControl+Alt+T",
          click: (_item, browserWindow) =>
            sendAction("new-terminal", getTargetBrowserWindow(browserWindow)),
        },
        ...(buildAgentMenuItems().length > 0
          ? [
              { type: "separator" as const },
              ...buildAgentMenuItems(),
              { type: "separator" as const },
            ]
          : [{ type: "separator" as const }]),
        ...(buildPluginMenuItems("terminal").length > 0
          ? [...buildPluginMenuItems("terminal"), { type: "separator" as const }]
          : []),
        {
          label: "Quick Switcher...",
          accelerator: "CommandOrControl+P",
          click: (_item, browserWindow) =>
            sendAction("open-quick-switcher", getTargetBrowserWindow(browserWindow)),
        },
        {
          label: "Command Palette...",
          accelerator: "CommandOrControl+Shift+P",
          click: (_item, browserWindow) =>
            sendAction("open-action-palette", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Install Canopy Command Line Tool",
          enabled: process.platform === "darwin" || process.platform === "linux",
          click: async (_item, browserWindow) => {
            const targetWin = getTargetBrowserWindow(browserWindow);
            try {
              const status = await CliInstallService.install();
              if (targetWin && !targetWin.isDestroyed()) {
                const wc = getAppWebContents(targetWin);
                if (!wc.isDestroyed()) {
                  wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                    type: "success",
                    title: "CLI Installed",
                    message: `The \`canopy\` command is now available at ${status.path}`,
                  });
                }
              }
              createApplicationMenu(mainWindow, cliAvailabilityService);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (targetWin && !targetWin.isDestroyed()) {
                const wc = getAppWebContents(targetWin);
                if (!wc.isDestroyed()) {
                  wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                    type: "error",
                    title: "CLI Installation Failed",
                    message,
                  });
                }
              }
            }
          },
        },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Getting Started",
          click: (_item, browserWindow) =>
            sendAction("show-getting-started", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Launch Help Agent",
          click: (_item, browserWindow) =>
            sendAction("launch-help-agent", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Reload Configuration",
          click: (_item, browserWindow) =>
            sendAction("reload-config", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        {
          label: "Learn More",
          click: async () => {
            await shell.openExternal("https://github.com/canopyide/canopy");
          },
        },
        ...(process.platform !== "darwin" && app.isPackaged
          ? [
              { type: "separator" as const },
              {
                label: "Check for Updates...",
                click: () => autoUpdaterService.checkForUpdatesManually(),
              },
            ]
          : []),
        ...(buildPluginMenuItems("help").length > 0
          ? [{ type: "separator" as const }, ...buildPluginMenuItems("help")]
          : []),
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: "Canopy",
      submenu: [
        { role: "about" },
        ...(app.isPackaged
          ? [
              {
                label: "Check for Updates...",
                click: () => autoUpdaterService.checkForUpdatesManually(),
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CommandOrControl+,",
          click: (_item, browserWindow) =>
            sendAction("open-settings", getTargetBrowserWindow(browserWindow)),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function buildRecentProjectsMenu(
  getTarget: (browserWindow: Electron.BaseWindow | undefined) => BrowserWindow | null,
  cliAvailabilityService?: CliAvailabilityService
): Electron.MenuItemConstructorOptions[] {
  const projects = projectStore.getAllProjects();

  if (projects.length === 0) {
    return [{ label: "No Recent Projects", enabled: false }];
  }

  const sortedProjects = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);

  const menuItems: Electron.MenuItemConstructorOptions[] = sortedProjects.map((project) => ({
    label: `${project.emoji || "📁"} ${project.name} - ${project.path}`,
    click: async (_item: Electron.MenuItem, browserWindow: Electron.BaseWindow | undefined) => {
      const targetWindow = getTarget(browserWindow);
      if (!targetWindow) return;
      await handleDirectoryOpen(project.path, targetWindow, cliAvailabilityService);
    },
  }));

  return menuItems;
}

export async function handleDirectoryOpen(
  directoryPath: string,
  targetWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): Promise<void> {
  if (targetWindow.isDestroyed()) return;

  try {
    const project = await projectStore.addProject(directoryPath);

    // Use ProjectViewManager for multi-view switching when available
    const pvm = getProjectViewManager();
    if (pvm) {
      await pvm.switchTo(project.id, project.path);
      await projectStore.setCurrentProject(project.id);
    } else {
      // Fallback: legacy single-view switch
      const registry = getWindowRegistry();
      const wCtx = registry?.getByWindowId(targetWindow.id);
      const switchService = wCtx?.services.projectSwitchService;
      if (!switchService) {
        console.error("[menu] ProjectSwitchService not available yet, cannot switch project");
        return;
      }
      await switchService.switchProject(project.id);
    }

    createApplicationMenu(targetWindow, cliAvailabilityService);
  } catch (error) {
    console.error("Failed to open project:", error);

    let errorMessage = "An unknown error occurred";
    if (error instanceof Error) {
      if (error.message.includes("Not a git repository")) {
        errorMessage = "The selected directory is not a Git repository.";
      } else if (error.message.includes("ENOENT")) {
        errorMessage = "The selected directory does not exist.";
      } else if (error.message.includes("EACCES")) {
        errorMessage = "Permission denied. You don't have access to this directory.";
      } else {
        errorMessage = error.message;
      }
    }

    dialog
      .showMessageBox(targetWindow, {
        type: "error",
        title: "Failed to Open Project",
        message: errorMessage,
        buttons: ["OK"],
      })
      .catch(console.error);
  }
}
