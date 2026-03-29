import { Menu, dialog, BrowserWindow, shell, app } from "electron";
import { projectStore } from "./services/ProjectStore.js";
import { CHANNELS } from "./ipc/channels.js";
import { getEffectiveRegistry } from "../shared/config/agentRegistry.js";
import type { CliAvailabilityService } from "./services/CliAvailabilityService.js";
import * as CliInstallService from "./services/CliInstallService.js";
import { getProjectSwitchServiceRef } from "./window/windowServices.js";
import { autoUpdaterService } from "./services/AutoUpdaterService.js";
import { getPluginMenuItems } from "./services/pluginMenuRegistry.js";

app.setAboutPanelOptions({
  applicationName: "Canopy",
  applicationVersion: app.getVersion(),
  version: "Beta",
  copyright: "© 2025 Canopy Team",
  website: "https://github.com/gregpriday/canopy-electron",
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

  const sendAction = (action: string) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try {
        mainWindow.webContents.send(CHANNELS.MENU_ACTION, action);
      } catch {
        // Silently ignore send failures during window disposal.
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
          click: () => sendAction(`launch-agent:${agent.id}`),
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
        click: () => sendAction(`plugin:${item.actionId}`),
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
          click: async () => {
            if (mainWindow.isDestroyed()) return;
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ["openDirectory", "createDirectory"],
              title: "Open Git Repository",
            });

            if (!result.canceled && result.filePaths.length > 0) {
              const directoryPath = result.filePaths[0];
              await handleDirectoryOpen(directoryPath, mainWindow, cliAvailabilityService);
            }
          },
        },
        {
          label: "New Worktree...",
          accelerator: "CommandOrControl+N",
          click: () => sendAction("new-worktree"),
        },
        {
          label: "Open Recent",
          submenu: buildRecentProjectsMenu(mainWindow, cliAvailabilityService),
        },
        { type: "separator" },
        {
          label: "Project Settings",
          click: () => sendAction("open-settings"),
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
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CommandOrControl+B",
          click: () => sendAction("toggle-sidebar"),
        },
        { type: "separator" },
        {
          label: "Reload",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            win.webContents.reload();
          },
        },
        {
          label: "Force Reload",
          click: (_item, browserWindow) => {
            const win = getTargetBrowserWindow(browserWindow);
            if (!win) return;
            win.webContents.reloadIgnoringCache();
          },
        },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
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
          click: () => sendAction("duplicate-panel"),
        },
        {
          label: "New Terminal",
          accelerator: "CommandOrControl+Alt+T",
          click: () => sendAction("new-terminal"),
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
          click: () => sendAction("open-quick-switcher"),
        },
        {
          label: "Command Palette...",
          accelerator: "CommandOrControl+Shift+P",
          click: () => sendAction("open-action-palette"),
        },
        { type: "separator" },
        {
          label: "Install Canopy Command Line Tool",
          enabled: process.platform === "darwin" || process.platform === "linux",
          click: async () => {
            try {
              const status = await CliInstallService.install();
              if (
                mainWindow &&
                !mainWindow.isDestroyed() &&
                !mainWindow.webContents.isDestroyed()
              ) {
                mainWindow.webContents.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                  type: "success",
                  title: "CLI Installed",
                  message: `The \`canopy\` command is now available at ${status.path}`,
                });
              }
              createApplicationMenu(mainWindow, cliAvailabilityService);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (
                mainWindow &&
                !mainWindow.isDestroyed() &&
                !mainWindow.webContents.isDestroyed()
              ) {
                mainWindow.webContents.send(CHANNELS.NOTIFICATION_SHOW_TOAST, {
                  type: "error",
                  title: "CLI Installation Failed",
                  message,
                });
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
          click: () => sendAction("show-getting-started"),
        },
        { type: "separator" },
        {
          label: "Learn More",
          click: async () => {
            await shell.openExternal("https://github.com/gregpriday/canopy-electron");
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
          click: () => sendAction("open-settings"),
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
  mainWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): Electron.MenuItemConstructorOptions[] {
  const projects = projectStore.getAllProjects();

  if (projects.length === 0) {
    return [{ label: "No Recent Projects", enabled: false }];
  }

  const sortedProjects = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);

  const menuItems: Electron.MenuItemConstructorOptions[] = sortedProjects.map((project) => ({
    label: `${project.emoji || "📁"} ${project.name} - ${project.path}`,
    click: async () => {
      await handleDirectoryOpen(project.path, mainWindow, cliAvailabilityService);
    },
  }));

  return menuItems;
}

export async function handleDirectoryOpen(
  directoryPath: string,
  mainWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): Promise<void> {
  if (mainWindow.isDestroyed()) return;

  try {
    const switchService = getProjectSwitchServiceRef();
    if (!switchService) {
      console.error("[menu] ProjectSwitchService not available yet, cannot switch project");
      return;
    }

    const project = await projectStore.addProject(directoryPath);
    await switchService.switchProject(project.id);

    createApplicationMenu(mainWindow, cliAvailabilityService);
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

    dialog.showErrorBox("Failed to Open Project", errorMessage);
  }
}
