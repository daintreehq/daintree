import { Menu, dialog, BrowserWindow, shell } from "electron";
import { projectStore } from "./services/ProjectStore.js";
import { getWorkspaceClient } from "./services/WorkspaceClient.js";
import { CHANNELS } from "./ipc/channels.js";

export function createApplicationMenu(mainWindow: BrowserWindow): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Directory...",
          accelerator: "CommandOrControl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ["openDirectory"],
              title: "Open Git Repository",
            });

            if (!result.canceled && result.filePaths.length > 0) {
              const directoryPath = result.filePaths[0];
              await handleDirectoryOpen(directoryPath, mainWindow);
            }
          },
        },
        {
          label: "Open Recent",
          submenu: buildRecentProjectsMenu(mainWindow),
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

function buildRecentProjectsMenu(mainWindow: BrowserWindow): Electron.MenuItemConstructorOptions[] {
  const projects = projectStore.getAllProjects();

  if (projects.length === 0) {
    return [{ label: "No Recent Projects", enabled: false }];
  }

  const sortedProjects = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);

  const menuItems: Electron.MenuItemConstructorOptions[] = sortedProjects.map((project) => ({
    label: `${project.emoji || "📁"} ${project.name} - ${project.path}`,
    click: async () => {
      await handleDirectoryOpen(project.path, mainWindow);
    },
  }));

  return menuItems;
}

async function handleDirectoryOpen(
  directoryPath: string,
  mainWindow: BrowserWindow
): Promise<void> {
  try {
    const project = await projectStore.addProject(directoryPath);

    await projectStore.setCurrentProject(project.id);

    const updatedProject = projectStore.getProjectById(project.id);
    if (!updatedProject) {
      throw new Error(`Project not found after update: ${project.id}`);
    }

    await getWorkspaceClient().refresh();

    mainWindow.webContents.send(CHANNELS.PROJECT_ON_SWITCH, updatedProject);

    createApplicationMenu(mainWindow);
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

export function updateApplicationMenu(mainWindow: BrowserWindow): void {
  createApplicationMenu(mainWindow);
}
