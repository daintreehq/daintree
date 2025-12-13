import { Menu, dialog, BrowserWindow, shell, app } from "electron";
import { projectStore } from "./services/ProjectStore.js";
import { getWorkspaceClient } from "./services/WorkspaceClient.js";
import { CHANNELS } from "./ipc/channels.js";
import { AGENT_REGISTRY } from "../shared/config/agentRegistry.js";
import type { CliAvailabilityService } from "./services/CliAvailabilityService.js";

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
  const sendAction = (action: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.MENU_ACTION, action);
    }
  };

  const availability = cliAvailabilityService?.getAvailability();

  const buildAgentMenuItems = (): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [];

    Object.values(AGENT_REGISTRY).forEach((agent) => {
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
              properties: ["openDirectory"],
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
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "New Terminal",
          accelerator: "CommandOrControl+T",
          click: () => sendAction("new-terminal"),
        },
        ...(buildAgentMenuItems().length > 0
          ? [
              { type: "separator" as const },
              ...buildAgentMenuItems(),
              { type: "separator" as const },
            ]
          : [{ type: "separator" as const }]),
        {
          label: "Terminal Palette...",
          accelerator: "CommandOrControl+P",
          click: () => sendAction("open-agent-palette"),
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
          label: "Learn More",
          click: async () => {
            await shell.openExternal("https://github.com/gregpriday/canopy-electron");
          },
        },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: "Canopy",
      submenu: [
        { role: "about" },
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

async function handleDirectoryOpen(
  directoryPath: string,
  mainWindow: BrowserWindow,
  cliAvailabilityService?: CliAvailabilityService
): Promise<void> {
  if (mainWindow.isDestroyed()) return;

  try {
    const project = await projectStore.addProject(directoryPath);

    await projectStore.setCurrentProject(project.id);

    const updatedProject = projectStore.getProjectById(project.id);
    if (!updatedProject) {
      throw new Error(`Project not found after update: ${project.id}`);
    }

    await getWorkspaceClient().refresh();

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.PROJECT_ON_SWITCH, updatedProject);
    }

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
